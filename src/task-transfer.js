import {
  exportTaskRecords,
  IMPORT_LIMITS,
  markPossibleDuplicates,
  parseNumberedTasks,
  recordsToMarkdown,
  validBusinessDate
} from "./task-transfer-core.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function docxHtmlToNumberedText(html) {
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  const lines = [];
  let number = 0;
  for (const node of documentNode.body.children) {
    if (node.tagName === "OL") {
      for (const item of node.querySelectorAll(":scope > li")) {
        number += 1;
        lines.push(`${number}、${item.textContent.trim()}`);
      }
      continue;
    }
    const text = node.textContent.trim();
    if (text) lines.push(/^(日期|时间|优先级|完成状态)\s*[：:]/.test(text) ? `   ${text}` : text);
  }
  return lines.join("\n");
}

async function readImportFile(file) {
  if (!file) return "";
  if (file.size > MAX_FILE_BYTES) throw new Error("文件不能超过 5 MB。");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "doc") throw new Error("首版不支持 .doc，请先在 Word 中另存为 .docx。");
  if (extension === "md") return file.text();
  if (extension !== "docx") throw new Error("只支持 UTF-8 Markdown（.md）或 Word（.docx）文件。");
  try {
    const { default: mammoth } = await import("mammoth");
    const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, { includeDefaultStyleMap: true });
    return docxHtmlToNumberedText(result.value);
  } catch {
    throw new Error("Word 文件已损坏或不是有效的 .docx 文件。");
  }
}

function scopeLabel(scope) {
  if (scope.mode === "all") return "全部任务";
  if (scope.mode === "current") return scope.date;
  return `${scope.start} 至 ${scope.end}`;
}

function exportFilename(scope, extension) {
  const label = scope.mode === "all" ? "全部" : scope.mode === "current" ? scope.date : `${scope.start}_${scope.end}`;
  return `TO-DO-LIST_任务_${label}.${extension}`;
}

async function downloadDocx(records, scope) {
  const { Document, Packer, Paragraph, TextRun } = await import("docx");
  const children = [
    new Paragraph({ children: [new TextRun({ text: "TO DO LIST 任务导出", bold: true, size: 32 })] }),
    new Paragraph({ children: [new TextRun(`导出范围：${scopeLabel(scope)}`)] }),
    new Paragraph({ children: [new TextRun("说明：这是可读任务清单，不是完整备份；重新导入重复任务时会按默认日期创建单日任务。") ] })
  ];
  if (!records.length) children.push(new Paragraph("当前范围内没有任务。"));
  for (const record of records) {
    children.push(new Paragraph({ spacing: { before: 220 }, children: [new TextRun({ text: `${record.number}、${record.title}`, bold: true })] }));
    children.push(new Paragraph({ indent: { left: 420 }, text: `日期：${record.date}` }));
    children.push(new Paragraph({ indent: { left: 420 }, text: `时间：${record.time}` }));
    children.push(new Paragraph({ indent: { left: 420 }, text: `优先级：${record.priority}` }));
    children.push(new Paragraph({ indent: { left: 420 }, text: `完成状态：${record.completions.length ? record.completions.map(item => `${item.date} ${item.completed ? "已完成" : "未完成"}`).join("；") : "范围内无日期"}` }));
  }
  const documentFile = new Document({ sections: [{ properties: {}, children }] });
  downloadBlob(await Packer.toBlob(documentFile), exportFilename(scope, "docx"));
}

export function setupTaskTransfer({ importButton, exportButton, getSelectedDate, getTasks, getCompletions, createTasks, notify }) {
  const importDialog = document.createElement("dialog");
  importDialog.className = "transfer-dialog";
  importDialog.innerHTML = `<form class="dialog-inner transfer-inner" method="dialog" novalidate>
    <div class="transfer-heading"><div><p>IMPORT / 导入</p><h2>从编号文本建立任务</h2></div><button class="icon-button" value="cancel" aria-label="关闭导入">×</button></div>
    <p class="form-hint">支持 1、内容 / 1. 内容 / 1) 内容 / 1. [ ] 内容；Word 和 Markdown 都只在当前浏览器读取。此清单不是完整备份，重复规则和完成历史不会通过普通导入恢复。</p>
    <div class="transfer-source-grid"><div class="field"><label for="transferDate">默认目标日期</label><input id="transferDate" type="date"></div><div class="field"><label for="transferFile">读取文件</label><input id="transferFile" type="file" accept=".md,.docx,.doc"></div></div>
    <div class="field"><label for="transferText">编号任务文本</label><textarea id="transferText" rows="9" maxlength="${IMPORT_LIMITS.maxCharacters}" placeholder="1、完成数学作业\n2、阅读第二章\n3、整理课堂笔记"></textarea></div>
    <div class="form-actions transfer-parse-actions"><button class="button" id="transferParse" type="button">解析并预览</button><span id="transferCount"></span></div>
    <div id="transferErrors" class="transfer-errors" role="alert"></div>
    <div id="transferPreview" class="transfer-preview"></div>
    <p class="form-hint">导出文件中的“完成状态”仅作说明，重新导入不会自动勾选完成。</p>
    <div class="form-actions"><button class="button" value="cancel">取消</button><button class="button primary" id="transferConfirm" type="button" disabled>创建所选任务</button></div>
  </form>`;
  document.body.append(importDialog);

  const exportDialog = document.createElement("dialog");
  exportDialog.className = "transfer-dialog";
  exportDialog.innerHTML = `<form class="dialog-inner transfer-inner" method="dialog" novalidate>
    <div class="transfer-heading"><div><p>EXPORT / 导出</p><h2>导出当前账号任务</h2></div><button class="icon-button" value="cancel" aria-label="关闭导出">×</button></div>
    <fieldset class="transfer-scope"><legend>导出范围</legend><label><input type="radio" name="exportScope" value="current" checked> 当前查看日期</label><label><input type="radio" name="exportScope" value="range"> 指定日期范围</label><label><input type="radio" name="exportScope" value="all"> 全部任务</label></fieldset>
    <div class="date-range" id="exportDates" hidden><div class="field"><label for="exportStart">开始日期</label><input id="exportStart" type="date"></div><div class="field"><label for="exportEnd">结束日期</label><input id="exportEnd" type="date"></div></div>
    <fieldset class="transfer-scope"><legend>文件格式</legend><label><input type="radio" name="exportFormat" value="md" checked> Markdown (.md)</label><label><input type="radio" name="exportFormat" value="docx"> Word (.docx)</label></fieldset>
    <p class="form-error" id="exportError" role="alert"></p>
    <div class="form-actions"><button class="button" value="cancel">取消</button><button class="button primary" id="exportConfirm" type="button">生成并下载</button></div>
  </form>`;
  document.body.append(exportDialog);

  const byId = (root, id) => root.querySelector(`#${id}`);
  const input = byId(importDialog, "transferText");
  const dateInput = byId(importDialog, "transferDate");
  const fileInput = byId(importDialog, "transferFile");
  const preview = byId(importDialog, "transferPreview");
  const errorBox = byId(importDialog, "transferErrors");
  const confirmImport = byId(importDialog, "transferConfirm");
  let parsedItems = [];

  function renderPreview(errors = []) {
    errorBox.replaceChildren(...errors.map(error => {
      const p = document.createElement("p");
      p.textContent = `${error.line ? `第 ${error.line} 行：` : ""}${error.message}`;
      return p;
    }));
    preview.replaceChildren(...parsedItems.map((item, index) => {
      const row = document.createElement("section");
      row.className = `transfer-row${item.duplicate ? " duplicate" : ""}`;
      row.innerHTML = `<label class="transfer-select"><input data-field="selected" type="checkbox" ${item.selected ? "checked" : ""}> <span>${item.duplicate ? "可能重复，仍然创建" : "创建此项"}</span></label><div class="transfer-row-fields"><label class="transfer-title-field">标题<input data-field="title" maxlength="160"></label><label>${item.type === "range" ? "开始日期" : "日期"}<input data-field="start-date" type="date"></label>${item.type === "range" ? '<label>结束日期<input data-field="end-date" type="date"></label>' : ""}<label>开始时间<input data-field="start-time" type="time"></label><label>结束时间<input data-field="end-time" type="time"></label><label>优先级<select data-field="priority"><option value="normal">普通</option><option value="urgent">紧急</option></select></label></div><small>原编号 ${item.sourceNumber}${item.type === "range" ? " · 日期范围任务" : ""}${item.completionIgnored ? " · 原文件含完成记录，本次不会恢复完成状态" : ""}${item.recurrenceIgnored ? " · 重复规则不会恢复，将创建单日任务" : ""}</small>`;
      const selectedControl = row.querySelector('[data-field="selected"]');
      const titleControl = row.querySelector('[data-field="title"]');
      const startDateControl = row.querySelector('[data-field="start-date"]');
      const endDateControl = row.querySelector('[data-field="end-date"]');
      const startTimeControl = row.querySelector('[data-field="start-time"]');
      const endTimeControl = row.querySelector('[data-field="end-time"]');
      const priorityControl = row.querySelector('[data-field="priority"]');
      selectedControl.addEventListener("change", () => { item.selected = selectedControl.checked; updateCount(); });
      titleControl.value = item.title;
      titleControl.addEventListener("input", () => { item.title = titleControl.value.trim(); updateCount(); });
      startDateControl.value = item.type === "single" ? item.date : item.startDate;
      startDateControl.addEventListener("change", () => {
        if (item.type === "single") item.date = startDateControl.value;
        else item.startDate = startDateControl.value;
        updateCount();
      });
      if (endDateControl) {
        endDateControl.value = item.endDate;
        endDateControl.addEventListener("change", () => { item.endDate = endDateControl.value; updateCount(); });
      }
      startTimeControl.value = item.startTime || "";
      endTimeControl.value = item.endTime || "";
      startTimeControl.addEventListener("change", () => { item.startTime = startTimeControl.value || null; updateCount(); });
      endTimeControl.addEventListener("change", () => { item.endTime = endTimeControl.value || null; updateCount(); });
      priorityControl.value = item.priority;
      priorityControl.addEventListener("change", () => { item.priority = priorityControl.value; });
      row.dataset.index = String(index);
      return row;
    }));
    updateCount();
  }

  function updateCount() {
    const selected = parsedItems.filter(item => item.selected);
    const invalid = selected.filter(item => !item.title || item.title.length > 160
      || !validBusinessDate(item.type === "single" ? item.date : item.startDate)
      || (item.type === "range" && (!validBusinessDate(item.endDate) || item.startDate > item.endDate))
      || (Boolean(item.startTime) !== Boolean(item.endTime)) || (item.startTime && item.startTime >= item.endTime));
    byId(importDialog, "transferCount").textContent = `将创建 ${selected.length} 条`;
    confirmImport.disabled = !selected.length || Boolean(invalid.length) || Boolean(errorBox.children.length);
  }

  function parse() {
    const result = parseNumberedTasks(input.value, dateInput.value);
    parsedItems = markPossibleDuplicates(result.items, getTasks());
    renderPreview(result.errors);
  }

  importButton.addEventListener("click", () => {
    dateInput.value = getSelectedDate();
    input.value = "";
    fileInput.value = "";
    parsedItems = [];
    renderPreview();
    importDialog.showModal();
    input.focus();
  });
  byId(importDialog, "transferParse").addEventListener("click", parse);
  fileInput.addEventListener("change", async () => {
    errorBox.replaceChildren();
    try {
      input.value = await readImportFile(fileInput.files[0]);
      parse();
    } catch (error) {
      parsedItems = [];
      renderPreview([{ line: 0, message: error.message }]);
    }
  });
  confirmImport.addEventListener("click", async () => {
    const selected = parsedItems.filter(item => item.selected).map(item => ({
      title: item.title,
      type: item.type,
      date: item.type === "single" ? item.date : item.startDate,
      startDate: item.type === "range" ? item.startDate : null,
      endDate: item.type === "range" ? item.endDate : null,
      priority: item.priority,
      startTime: item.startTime,
      endTime: item.endTime
    }));
    confirmImport.disabled = true;
    const result = await createTasks(selected);
    if (result.failures.length) {
      const failedTitles = new Set(result.failures.map(item => item.task.title));
      parsedItems = parsedItems.filter(item => failedTitles.has(item.title));
      renderPreview(result.failures.map(item => ({ line: 0, message: `${item.task.title}：${item.error}` })));
      notify(`已创建 ${result.successes.length} 条，${result.failures.length} 条失败；预览中仅保留未成功条目。`, "error");
    } else {
      notify(`已创建 ${result.successes.length} 条任务。`, "success");
      importDialog.close();
    }
  });

  const exportDates = byId(exportDialog, "exportDates");
  exportButton.addEventListener("click", () => {
    const selectedDate = getSelectedDate();
    byId(exportDialog, "exportStart").value = selectedDate;
    byId(exportDialog, "exportEnd").value = selectedDate;
    byId(exportDialog, "exportError").textContent = "";
    exportDialog.querySelector('input[name="exportScope"][value="current"]').checked = true;
    exportDates.hidden = true;
    exportDialog.showModal();
  });
  exportDialog.querySelectorAll('input[name="exportScope"]').forEach(radio => radio.addEventListener("change", () => {
    exportDates.hidden = exportDialog.querySelector('input[name="exportScope"]:checked').value !== "range";
  }));
  byId(exportDialog, "exportConfirm").addEventListener("click", async () => {
    const mode = exportDialog.querySelector('input[name="exportScope"]:checked').value;
    const scope = mode === "current" ? { mode, date: getSelectedDate() } : mode === "all" ? { mode } : {
      mode, start: byId(exportDialog, "exportStart").value, end: byId(exportDialog, "exportEnd").value
    };
    if (mode === "range" && (!validBusinessDate(scope.start) || !validBusinessDate(scope.end) || scope.start > scope.end)) {
      byId(exportDialog, "exportError").textContent = "请选择有效的日期范围。";
      return;
    }
    const records = exportTaskRecords(getTasks(), getCompletions(), scope);
    const format = exportDialog.querySelector('input[name="exportFormat"]:checked').value;
    try {
      if (format === "md") {
        const markdown = recordsToMarkdown(records, scopeLabel(scope));
        downloadBlob(new Blob([`\uFEFF${markdown}`], { type: "text/markdown;charset=utf-8" }), exportFilename(scope, "md"));
      } else await downloadDocx(records, scope);
      exportDialog.close();
      notify(`已导出 ${records.length} 条任务。`, "success");
    } catch (error) {
      byId(exportDialog, "exportError").textContent = `导出失败：${error?.message || "未知错误"}`;
    }
  });

  return { close() { importDialog.close(); exportDialog.close(); } };
}
