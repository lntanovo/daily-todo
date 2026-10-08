import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_TABLES, createManifest, sanitizeBackupRows, stableStringify, validateBackup } from "../src/backup-core.js";

function emptyData() { return Object.fromEntries(BACKUP_TABLES.map((table) => [table, []])); }

test("backup strips account and credential fields", () => {
  assert.deepEqual(sanitizeBackupRows("todo_tasks", [{ id: "1", owner_id: "secret", token: "no", title: "ok" }]), [{ id: "1", title: "ok" }]);
  assert.deepEqual(sanitizeBackupRows("todo_preferences", [{ owner_id: "secret", background_kind: "upload", background_value: "secret/photo.png" }]), [{ background_kind: "upload", background_value: "" }]);
});

test("backup validates checksums and required tables", async () => {
  const text = stableStringify(emptyData());
  const manifest = await createManifest(text);
  assert.deepEqual(await validateBackup({ manifest, dataText: text }), emptyData());
  await assert.rejects(() => validateBackup({ manifest, dataText: `${text} ` }), /校验失败/);
  await assert.rejects(() => validateBackup({ manifest: { ...manifest, version: 2 }, dataText: text }), /版本不受支持/);
  await assert.rejects(() => validateBackup({ manifest: { ...manifest, background: { name: "../secret.png", size: 0, sha256: "" } }, dataText: text }), /路径不安全/);
  const missing = stableStringify({ todo_tasks: [] });
  const missingManifest = await createManifest(missing);
  await assert.rejects(() => validateBackup({ manifest: missingManifest, dataText: missing }), /缺少/);
});
