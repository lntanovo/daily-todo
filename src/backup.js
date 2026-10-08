import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { BACKUP_TABLES, createManifest, restoreSummary, sanitizeBackupRows, stableStringify, validateBackup } from "./backup-core.js";

const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;

function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const TABLE_LABELS = {
  todo_tasks: "任务（含最近删除）", todo_task_recurrences: "重复规则",
  todo_daily_completions: "每日完成", todo_completion_history: "完成历史",
  todo_daily_notes: "每日补充", todo_focus_sessions: "专注记录",
  todo_task_templates: "任务模板", todo_preferences: "外观偏好",
};

function previewRestore(summary, hasBackground) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "transfer-dialog";
    dialog.innerHTML = `<div class="dialog-inner transfer-inner"><div class="feature-heading"><h2>预览备份恢复</h2><button class="icon-button" type="button" data-cancel aria-label="取消">×</button></div><p class="form-hint">按类别合并，已有同 ID 记录会跳过。完成记录和历史在一个数据库事务中提交。</p><div class="backup-preview-list"></div><div class="form-actions"><button class="button" type="button" data-cancel>取消</button><button class="button primary" id="backupRestoreConfirm" type="button">开始恢复</button></div></div>`;
    const list = dialog.querySelector(".backup-preview-list");
    for (const [table, item] of Object.entries(summary)) {
      const label = document.createElement("label");
      label.className = "backup-preview-row";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = table; checkbox.checked = true;
      const description = document.createElement("span");
      description.textContent = `${TABLE_LABELS[table]} · 新增 ${item.new} · 相同 ${item.duplicate} · 冲突跳过 ${item.conflict}`;
      label.append(checkbox, description); list.append(label);
    }
    if (hasBackground) {
      const label = document.createElement("label"); label.className = "backup-preview-row";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = "background"; checkbox.checked = true;
      const description = document.createElement("span"); description.textContent = "自定义背景 · 将切换到备份中的图片";
      label.append(checkbox, description); list.append(label);
    }
    function done(value) { dialog.close(); dialog.remove(); resolve(value); }
    dialog.querySelectorAll("[data-cancel]").forEach(button => button.addEventListener("click", () => done(null)));
    dialog.addEventListener("cancel", event => { event.preventDefault(); done(null); });
    dialog.querySelector("#backupRestoreConfirm").addEventListener("click", () => done(new Set([...list.querySelectorAll("input:checked")].map(input => input.value))));
    document.body.append(dialog); dialog.showModal();
  });
}

export function setupBackup({ app, db, exportButton, importButton, fileInput, getUid, appearance, cloudResult, notify, reload }) {
  async function readAll() {
    const result = {};
    await Promise.all(BACKUP_TABLES.map(async (table) => {
      const order = table === "todo_preferences" ? "owner_id" : ["todo_daily_completions", "todo_daily_notes", "todo_completion_history", "todo_task_recurrences"].includes(table) ? "task_id" : "id";
      const rows = [];
      for (let offset = 0; ; offset += 200) {
        const page = await cloudResult(db.from(table).select("*").order(order, { ascending: true }).range(offset, offset + 199));
        if (!Array.isArray(page)) throw new Error(`${table} 读取结果无效。`);
        rows.push(...page);
        if (page.length < 200) break;
        if (rows.length > 100000) throw new Error(`${table} 的记录数超过备份上限。`);
      }
      result[table] = sanitizeBackupRows(table, rows);
    }));
    return result;
  }

  exportButton.addEventListener("click", async () => {
    if (!getUid()) return;
    exportButton.disabled = true;
    try {
      const data = await readAll();
      const dataText = stableStringify(data);
      const background = await appearance.exportBackground();
      const manifest = await createManifest(dataText, background?.bytes || null, background?.name || "");
      const files = {
        "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
        "data.json": strToU8(dataText),
      };
      if (background) files[background.name] = background.bytes;
      const archive = zipSync(files, { level: 6 });
      download(archive, `warm-paper-backup-${new Date().toISOString().slice(0, 10)}.zip`);
      notify("完整备份已生成。请妥善保管 ZIP 文件。", "success");
    } catch (error) { notify(`备份失败：${error.message}`, "error"); }
    finally { exportButton.disabled = false; }
  });

  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0]; fileInput.value = "";
    if (!file || !getUid()) return;
    const accountId = getUid();
    if (file.size > MAX_ARCHIVE_BYTES) return notify("备份文件超过 40MB 安全上限。", "error");
    importButton.disabled = true;
    try {
      const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: ({ name, originalSize }) => {
        if (!(["manifest.json", "data.json"].includes(name) || /^background\.(?:png|jpe?g|webp|gif)$/i.test(name))) throw new Error("备份包含未知或不安全的 ZIP 路径。");
        if (originalSize > 30 * 1024 * 1024) throw new Error("ZIP 中的文件超过安全上限。");
        return true;
      } });
      if (!archive["manifest.json"] || !archive["data.json"]) throw new Error("ZIP 中缺少清单或数据文件。");
      const manifest = JSON.parse(strFromU8(archive["manifest.json"]));
      const dataText = strFromU8(archive["data.json"]);
      const backgroundBytes = manifest.background ? archive[manifest.background.name] : null;
      if (archive["data.json"].byteLength > 20 * 1024 * 1024 || (backgroundBytes?.byteLength || 0) > 30 * 1024 * 1024) throw new Error("解压后的备份内容超过安全上限。");
      const data = await validateBackup({ manifest, dataText, backgroundBytes });
      const current = await readAll();
      const summary = restoreSummary(data, current);
      const selected = await previewRestore(summary, Boolean(backgroundBytes));
      if (!selected || !selected.size) return;
      const payload = Object.fromEntries(BACKUP_TABLES.map(table => [table, selected.has(table) ? data[table] : []]));
      const currentActive = current.todo_focus_sessions.some(row => ["running", "paused"].includes(row.status));
      const backupActive = payload.todo_focus_sessions.some(row => ["running", "paused"].includes(row.status));
      if (currentActive && backupActive) {
        if (!confirm("当前账号已有一轮活动专注。是否跳过备份中的活动计时，只恢复已结束的专注记录？取消将停止本次恢复。")) return;
        payload.todo_focus_sessions = payload.todo_focus_sessions.filter(row => !["running", "paused"].includes(row.status));
      }
      if (getUid() !== accountId) throw new Error("登录账号已变化，请重新选择备份。");
      notify("正在以数据库事务恢复所选记录…", "success");
      const restored = await cloudResult(db.rpc("restore_todo_backup_v1", { p_data: payload }));
      const inserted = Number(restored?.inserted) || 0;
      if (selected.has("background") && backgroundBytes) {
        const extension = manifest.background.name.split(".").pop()?.toLowerCase();
        const mime = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : extension === "gif" ? "image/gif" : "image/jpeg";
        await appearance.importBackground(new Blob([backgroundBytes], { type: mime }));
      }
      await reload();
      notify(`恢复完成：新增 ${inserted} 条数据库记录，现有记录已保留。`, "success");
    } catch (error) { notify(`恢复失败：${error.message}。数据库事务失败时不会写入部分记录；如背景上传失败，可重新导入。`, "error"); }
    finally { importButton.disabled = false; }
  });
}
