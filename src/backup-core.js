export const BACKUP_FORMAT = "warm-paper-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_TABLES = [
  "todo_tasks", "todo_task_recurrences", "todo_daily_completions",
  "todo_completion_history", "todo_daily_notes", "todo_focus_sessions",
  "todo_task_templates", "todo_preferences",
];

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256(bytes) {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export function sanitizeBackupRows(table, rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const clean = { ...row };
    delete clean.owner_id;
    delete clean.password;
    delete clean.token;
    delete clean.access_token;
    delete clean.refresh_token;
    if (table === "todo_preferences" && clean.background_kind === "upload") clean.background_value = "";
    return clean;
  });
}

export async function createManifest(dataText, backgroundBytes = null, backgroundName = "") {
  const data = JSON.parse(dataText);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    counts: Object.fromEntries(BACKUP_TABLES.map((table) => [table, data[table]?.length || 0])),
    data_sha256: await sha256(dataText),
    background: backgroundBytes ? {
      name: backgroundName,
      size: backgroundBytes.byteLength,
      sha256: await sha256(backgroundBytes),
    } : null,
  };
}

export async function validateBackup({ manifest, dataText, backgroundBytes = null, maxRows = 100000 }) {
  if (manifest?.format !== BACKUP_FORMAT || manifest?.version !== BACKUP_VERSION) throw new Error("备份格式或版本不受支持。");
  if (manifest.background && !/^background\.(?:png|jpe?g|webp|gif)$/i.test(manifest.background.name || "")) throw new Error("背景文件路径不安全。");
  if (await sha256(dataText) !== manifest.data_sha256) throw new Error("数据校验失败，备份可能已损坏。");
  const data = JSON.parse(dataText);
  let totalRows = 0;
  for (const table of BACKUP_TABLES) {
    if (!Array.isArray(data[table])) throw new Error(`备份缺少 ${table} 数据。`);
    if (data[table].length > maxRows) throw new Error(`${table} 的记录数超过安全上限。`);
    totalRows += data[table].length;
    if (manifest.counts?.[table] !== data[table].length) throw new Error(`${table} 的记录数与清单不符。`);
    if (data[table].some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error(`${table} 包含无效记录。`);
  }
  if (totalRows > maxRows) throw new Error("备份总记录数超过安全上限。");
  if (manifest.background) {
    if (!backgroundBytes || backgroundBytes.byteLength !== manifest.background.size) throw new Error("背景文件缺失或大小不符。");
    if (await sha256(backgroundBytes) !== manifest.background.sha256) throw new Error("背景文件校验失败。");
  }
  return data;
}

export function restoreSummary(data, current = {}) {
  const summary = {};
  for (const table of BACKUP_TABLES) {
    const rows = data[table] || [];
    const keyOf = (row) => table === "todo_preferences" ? "preference" : row.id || `${row.task_id}:${row.completion_date || row.note_date || ""}`;
    const existing = new Map((current[table] || []).map((row) => [keyOf(row), row]));
    summary[table] = {
      total: rows.length,
      new: rows.filter((row) => !existing.has(keyOf(row))).length,
      duplicate: rows.filter((row) => existing.has(keyOf(row)) && stableStringify(row) === stableStringify(existing.get(keyOf(row)))).length,
      conflict: rows.filter((row) => existing.has(keyOf(row)) && stableStringify(row) !== stableStringify(existing.get(keyOf(row)))).length,
    };
  }
  return summary;
}
