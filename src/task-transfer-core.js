import { recurrenceAppearsOn } from "./recurrence-core.js";

const NUMBERED_ITEM = /^(\d+)\s*(?:、|[.)])\s*(?:\[[ xX]\]\s*)?(.*)$/;
const META_LINE = /^\s{2,}(日期|时间|优先级|完成状态)\s*[：:]\s*(.*?)\s*$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const APP_EXPORT_HEADER = /^(?:#\s*)?TO DO LIST 任务导出$/;
const APP_EXPORT_SCOPE = /^导出范围：.+$/;
const APP_EXPORT_NOTE = /^说明：这是可读任务清单/;

export const IMPORT_LIMITS = Object.freeze({ maxCharacters: 200000, maxItems: 200 });

export function validBusinessDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function applyMetadata(item, label, value, lineNumber, errors) {
  if (label === "日期") {
    if (/^重复/.test(value)) { item.recurrenceIgnored = true; return; }
    const dates = value.match(/\d{4}-\d{2}-\d{2}/g) || [];
    if (dates.length === 1 && validBusinessDate(dates[0])) {
      item.type = "single";
      item.date = dates[0];
      delete item.startDate;
      delete item.endDate;
      return;
    }
    if (dates.length === 2 && validBusinessDate(dates[0]) && validBusinessDate(dates[1]) && dates[0] <= dates[1]) {
      item.type = "range";
      item.startDate = dates[0];
      item.endDate = dates[1];
      delete item.date;
      return;
    }
    errors.push({ line: lineNumber, message: "日期元数据无效，请使用 YYYY-MM-DD 或有效的起止日期。" });
  }
  if (label === "时间") {
    if (/^(无|未设置|—|-)$/.test(value)) return;
    const times = value.match(/(?:[01]\d|2[0-3]):[0-5]\d/g) || [];
    if (times.length === 2 && TIME.test(times[0]) && TIME.test(times[1]) && times[0] < times[1]) {
      item.startTime = times[0];
      item.endTime = times[1];
    } else errors.push({ line: lineNumber, message: "时间元数据无效，结束时间必须晚于开始时间。" });
  }
  if (label === "优先级") item.priority = /紧急|urgent/i.test(value) ? "urgent" : "normal";
  if (label === "完成状态") item.completionIgnored = true;
}

export function parseNumberedTasks(text, defaultDate, limits = IMPORT_LIMITS) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  const errors = [];
  const items = [];
  if (!validBusinessDate(defaultDate)) return { items, errors: [{ line: 0, message: "默认导入日期无效。" }] };
  if (source.length > limits.maxCharacters) return { items, errors: [{ line: 0, message: `输入内容不能超过 ${limits.maxCharacters} 个字符。` }] };

  let current = null;
  let expected = 1;
  source.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) return;
    if (!current && (APP_EXPORT_HEADER.test(line.trim()) || APP_EXPORT_SCOPE.test(line.trim()) || APP_EXPORT_NOTE.test(line.trim()))) return;
    const match = line.match(NUMBERED_ITEM);
    if (match) {
      const number = Number(match[1]);
      const title = match[2].trim();
      if (number !== expected) errors.push({ line: lineNumber, message: `编号应为 ${expected}，当前为 ${number}。` });
      expected = number + 1;
      current = {
        sourceNumber: number,
        sourceLine: lineNumber,
        title,
        type: "single",
        date: defaultDate,
        priority: "normal",
        startTime: null,
        endTime: null,
        selected: true,
        duplicate: false,
        completionIgnored: false
      };
      if (!title) errors.push({ line: lineNumber, message: "任务标题不能为空。" });
      if (title.length > 160) errors.push({ line: lineNumber, message: "任务标题超过 160 个字符。" });
      items.push(current);
      if (items.length > limits.maxItems) errors.push({ line: lineNumber, message: `一次最多导入 ${limits.maxItems} 条任务。` });
      return;
    }
    const metadata = line.match(META_LINE);
    if (metadata && current) {
      applyMetadata(current, metadata[1], metadata[2], lineNumber, errors);
      return;
    }
    errors.push({ line: lineNumber, message: current ? "无法判断这一行是否属于上一项；请改成编号任务或缩进的元数据。" : "任务必须从行首编号 1 开始。" });
  });
  if (!items.length && !errors.length) errors.push({ line: 0, message: "没有识别到编号任务。" });
  return { items: items.slice(0, limits.maxItems), errors };
}

function taskDates(task) {
  return task.type === "single" ? [task.date] : [task.startDate, task.endDate];
}

export function markPossibleDuplicates(items, existingTasks) {
  const seen = new Set();
  return items.map(item => {
    const key = `${item.title}\u0000${taskDates(item).join("\u0000")}`;
    const duplicate = seen.has(key) || existingTasks.some(task => task.title === item.title
      && task.type === item.type && taskDates(task).join("\u0000") === taskDates(item).join("\u0000"));
    seen.add(key);
    return { ...item, duplicate, selected: duplicate ? false : item.selected !== false };
  });
}

export function completionKeyFor(task, date) {
  return task.type === "single" ? task.id : `${task.id}:${date}`;
}

export function taskAppearsOn(task, date) {
  if (task.type === "single") return task.date === date;
  if (task.type === "range") return task.startDate <= date && task.endDate >= date;
  return task.type === "recurring" && recurrenceAppearsOn(task.recurrence, date);
}

export function dateKeysBetween(start, end, limit = 10000) {
  if (!validBusinessDate(start) || !validBusinessDate(end) || start > end) return [];
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  while (dates.length < limit) {
    const key = cursor.toISOString().slice(0, 10);
    if (key > end) break;
    dates.push(key);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function tasksForExport(tasks, scope) {
  const selected = tasks.filter(task => {
    if (scope.mode === "all") return true;
    const start = scope.mode === "current" ? scope.date : scope.start;
    const end = scope.mode === "current" ? scope.date : scope.end;
    if (task.type === "single") return task.date >= start && task.date <= end;
    if (task.type === "range") return task.startDate <= end && task.endDate >= start;
    return dateKeysBetween(start, end).some(date => taskAppearsOn(task, date));
  });
  return selected.sort((a, b) => {
    const firstA = a.type === "single" ? a.date : a.type === "range" ? a.startDate : a.recurrence?.start_date || "9999-12-31";
    const firstB = b.type === "single" ? b.date : b.type === "range" ? b.startDate : b.recurrence?.start_date || "9999-12-31";
    return firstA.localeCompare(firstB) || String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

function completionDatesFor(task, completions, scope) {
  if (task.type === "recurring" && scope.mode === "all") {
    return Object.keys(completions).filter(key => key.startsWith(`${task.id}:`))
      .map(key => key.slice(task.id.length + 1))
      .filter(date => validBusinessDate(date) && taskAppearsOn(task, date))
      .sort().map(date => ({ date, completed: true }));
  }
  if (task.type === "recurring") {
    const start = scope.mode === "current" ? scope.date : scope.start;
    const end = scope.mode === "current" ? scope.date : scope.end;
    return dateKeysBetween(start, end).filter(date => taskAppearsOn(task, date))
      .map(date => ({ date, completed: Boolean(completions[completionKeyFor(task, date)]) }));
  }
  let start = task.type === "single" ? task.date : task.startDate;
  let end = task.type === "single" ? task.date : task.endDate;
  if (scope.mode === "current") start = end = scope.date;
  if (scope.mode === "range") {
    if (start < scope.start) start = scope.start;
    if (end > scope.end) end = scope.end;
  }
  return dateKeysBetween(start, end).filter(date => taskAppearsOn(task, date)).map(date => ({
    date,
    completed: Boolean(completions[completionKeyFor(task, date)])
  }));
}

export function exportTaskRecords(tasks, completions, scope) {
  return tasksForExport(tasks, scope).map((task, index) => ({
    number: index + 1,
    title: task.title,
    date: task.type === "single" ? `单日 ${task.date}` : task.type === "range" ? `连续 ${task.startDate} — ${task.endDate}` : task.recurrence?.frequency === "monthly"
      ? `重复 每月 ${task.recurrence.month_day} 日；自 ${task.recurrence.start_date} 起${task.recurrence.end_date ? ` 至 ${task.recurrence.end_date}` : ""}`
      : `重复 每周 ${(task.recurrence?.weekdays || []).map(day => ["一", "二", "三", "四", "五", "六", "日"][day - 1]).join("、")}；自 ${task.recurrence?.start_date || ""} 起${task.recurrence?.end_date ? ` 至 ${task.recurrence.end_date}` : ""}`,
    time: task.startTime ? `${task.startTime}—${task.endTime}` : "无",
    priority: task.priority === "urgent" ? "紧急" : "普通",
    completions: completionDatesFor(task, completions, scope)
  }));
}

export function recordsToMarkdown(records, scopeLabel) {
  const lines = [`# TO DO LIST 任务导出`, "", `导出范围：${scopeLabel}`, "说明：这是可读任务清单，不是完整备份；重新导入重复任务时会按默认日期创建单日任务。", ""];
  if (!records.length) return `${lines.join("\n")}当前范围内没有任务。\n`;
  for (const record of records) {
    lines.push(`${record.number}、${record.title}`);
    lines.push(`   日期：${record.date}`);
    lines.push(`   时间：${record.time}`);
    lines.push(`   优先级：${record.priority}`);
    lines.push(`   完成状态：${record.completions.length ? record.completions.map(item => `${item.date} ${item.completed ? "已完成" : "未完成"}`).join("；") : "范围内无日期"}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
