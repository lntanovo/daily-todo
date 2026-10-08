import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";

const runtime = process.env.PLAYWRIGHT_MODULE || "C:/Users/lntano/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(runtime));
const url = process.env.TODO_FEATURE_TEST_URL || "http://127.0.0.1:5193/tests/features-fixture.html";
const projectDir = fileURLToPath(new URL("../", import.meta.url));
let server;
try { const response = await fetch(url); if (!response.ok) throw new Error(String(response.status)); }
catch {
  server = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--host", "127.0.0.1", "--port", new URL(url).port, "--strictPort"], { cwd: projectDir, stdio: "ignore" });
  for (let attempt = 0; attempt < 60; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await delay(100); if (attempt === 59) throw new Error("本地预览服务未能启动。"); }
}
const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

try {
  await page.goto(url);
  await page.waitForSelector("#appRoot:not([hidden])");
  const waitReady = () => page.waitForFunction(() => document.querySelector("#appRoot")?.getAttribute("aria-busy") !== "true");

  const quickTitle = `快速录入 ${Date.now()}`;
  await page.locator("#quickTaskTitle").fill(quickTitle);
  await page.locator("#quickAddForm button[type=submit]").click();
  await waitReady();
  assert.equal(await page.locator(".task-title", { hasText: quickTitle }).count(), 1);

  await page.locator("#quickTaskTitle").fill("模板里的固定事项");
  page.once("dialog", (dialog) => dialog.accept("我的常用模板"));
  await page.locator("#saveTemplateButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#quickTemplate option").length > 1);
  assert.equal((await page.evaluate(() => window.__fixture.snapshot().todo_task_templates)).length, 1);

  const recurringTitle = `每周复盘 ${Date.now()}`;
  await page.locator("#addButton").click();
  await page.locator("#taskTitle").fill(recurringTitle);
  await page.locator('input[name="taskType"][value="recurring"]').check({ force: true });
  await page.locator("#taskForm button[type=submit]").click();
  await waitReady();
  assert.equal(await page.locator(".task-title", { hasText: recurringTitle }).count(), 1);
  const fixture = await page.evaluate(() => window.__fixture.snapshot());
  const recurring = fixture.todo_tasks.find((task) => task.title === recurringTitle);
  assert.equal(recurring.type, "recurring");
  assert.equal(fixture.todo_task_recurrences.some((rule) => rule.task_id === recurring.id), true);

  const recurringRow = page.locator(`[data-id="${recurring.id}"]`);
  await recurringRow.locator('[data-action="delete"]').click();
  await waitReady();
  assert.equal(await recurringRow.count(), 0);
  assert.equal(await page.locator("#undoToast").isVisible(), true);
  await page.locator("#undoButton").click();
  await waitReady();
  assert.equal(await page.locator(`[data-id="${recurring.id}"]`).count(), 1);

  await page.locator('[data-view="focus"]').click();
  await page.locator("#focusMinutes").fill("1");
  await page.locator("#focusStart").click();
  await page.locator("#focusMini").waitFor({ state: "visible" });
  assert.equal((await page.evaluate(() => window.__fixture.snapshot().todo_focus_sessions)).length, 1);
  await page.locator("#focusEnd").click();
  await page.locator("#focusMini").waitFor({ state: "hidden" });

  await page.locator("#settingsButton").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#backupExportButton").click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  const archive = unzipSync(new Uint8Array(await readFile(backupPath)));
  const manifest = JSON.parse(strFromU8(archive["manifest.json"]));
  const data = JSON.parse(strFromU8(archive["data.json"]));
  assert.equal(manifest.format, "warm-paper-backup");
  assert.ok(data.todo_tasks.some((task) => task.title === recurringTitle));
  assert.ok(data.todo_focus_sessions.length >= 1);
  assert.equal(JSON.stringify(data).includes("fixture-user"), false);
  await page.evaluate((title) => {
    const snapshot = window.__fixture.snapshot();
    window.__fixture.replaceTable("todo_tasks", snapshot.todo_tasks.filter((task) => task.title !== title));
  }, quickTitle);
  await page.reload(); await page.waitForSelector("#appRoot:not([hidden])");
  assert.equal(await page.locator(".task-title", { hasText: quickTitle }).count(), 0);
  await page.locator("#settingsButton").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator("#backupImportButton").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(backupPath);
  await page.locator("#backupRestoreConfirm").click();
  await page.waitForFunction(() => document.querySelector("#storageStatus")?.textContent?.includes("恢复完成"));
  assert.equal(await page.locator(".task-title", { hasText: quickTitle }).count(), 1);
  const firstRestore = await page.evaluate(() => window.__fixture.snapshot());
  const secondChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#backupImportButton").click();
  const secondChooser = await secondChooserPromise;
  await secondChooser.setFiles(backupPath);
  await page.locator("#backupRestoreConfirm").click();
  await page.waitForFunction(() => document.querySelector("#storageStatus")?.textContent?.includes("新增 0 条"));
  const secondRestore = await page.evaluate(() => window.__fixture.snapshot());
  assert.equal(secondRestore.todo_tasks.length, firstRestore.todo_tasks.length);
  assert.equal(secondRestore.todo_focus_sessions.length, firstRestore.todo_focus_sessions.length);
  assert.equal(secondRestore.todo_completion_history.length, firstRestore.todo_completion_history.length);
  assert.deepEqual(errors, []);
  console.log("PASS quick entry, cloud templates, recurring rules, soft-delete undo, cloud focus and complete ZIP backup/merge restore");
} finally {
  await browser.close();
  server?.kill();
}
