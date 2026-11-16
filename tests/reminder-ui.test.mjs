import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// 复用本机已有的 Playwright，绝不自动安装依赖。
const runtime = process.env.PLAYWRIGHT_MODULE
  || "C:/Users/lntano/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(runtime));
const projectDir = fileURLToPath(new URL("../", import.meta.url));
const url = process.env.TODO_REMINDER_TEST_URL || "http://127.0.0.1:5194/tests/features-fixture.html";

let server;
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(response.status));
} catch {
  server = spawn(process.execPath, [
    fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
    "--host", "127.0.0.1", "--port", new URL(url).port, "--strictPort"
  ], { cwd: projectDir, stdio: "ignore" });
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await delay(100);
    if (attempt === 79) throw new Error("本地预览服务未能启动。");
  }
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", error => errors.push(error.stack || error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("dialog", dialog => dialog.accept());

const pass = label => console.log(`PASS ${label}`);
const openSettings = async () => {
  if (await page.locator("#settingsDrawer").isHidden()) await page.locator("#settingsButton").click();
  await page.locator("#settingsDrawer").waitFor({ state: "visible" });
};

try {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#appRoot")?.getAttribute("aria-busy") === "false");

  // 1. 任务卡片显示提醒时间，并且编辑表单能回填
  const single = page.locator('[data-id="fixture-single"]');
  assert.match(await single.locator(".task-remind").textContent(), /提醒 13:45/);
  await single.locator('[data-action="edit"]').click();
  assert.equal(await page.locator("#taskRemindTime").inputValue(), "13:45");
  assert.equal(await page.locator("#taskRemindEnabled").isChecked(), true);
  await page.locator("#cancelButton").click();
  pass("task remind time is rendered and pre-filled for editing");

  // 2. 关闭提醒开关后卡片不再显示提醒
  await single.locator('[data-action="edit"]').click();
  await page.locator("#taskRemindEnabled").uncheck();
  await page.locator('#taskForm button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector("#appRoot")?.getAttribute("aria-busy") === "false");
  assert.equal(await single.locator(".task-remind").count(), 0);
  await single.locator('[data-action="edit"]').click();
  assert.equal(await page.locator("#taskRemindEnabled").isChecked(), false);
  await page.locator("#taskRemindEnabled").check();
  await page.locator('#taskForm button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector("#appRoot")?.getAttribute("aria-busy") === "false");
  assert.equal(await single.locator(".task-remind").count(), 1);
  pass("remind toggle persists through the cloud save path");

  // 3. 设置抽屉能打开提醒区，并且初始为空、提示为占位
  await openSettings();
  assert.equal(await page.locator("#reminderFeishu").inputValue(), "");
  assert.match(await page.locator("#reminderFeishu").getAttribute("placeholder"), /open\.feishu\.cn/);
  pass("reminder section loads without echoing a stored webhook");

  // 4. 保存后只显示末尾四位
  await page.locator("#reminderFeishu").fill("https://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234");
  await page.locator("#reminderGrace").fill("45");
  await page.locator("#reminderDigestTime").fill("07:30");
  await page.locator("#reminderSave").click();
  await page.waitForFunction(() => /已保存/.test(document.querySelector("#reminderStatus")?.textContent || ""));
  assert.equal(await page.locator("#reminderFeishu").inputValue(), "");
  assert.match(await page.locator("#reminderFeishu").getAttribute("placeholder"), /…1234/);
  assert.doesNotMatch(await page.locator("#reminderFeishu").getAttribute("placeholder"), /abcd-1234/);
  assert.equal(await page.locator("#reminderGrace").inputValue(), "45");
  pass("saved webhook is masked and the full URL never returns to the page");

  // 4b. 提前倒计时与晚间收尾可以保存并回显
  await page.locator("#reminderLeadDays").fill("5");
  await page.locator("#reminderEveningTime").fill("21:15");
  await page.locator("#reminderEvening").uncheck();
  await page.locator("#reminderSave").click();
  await page.waitForFunction(() => document.querySelector("#reminderLeadDays")?.value === "5");
  assert.equal(await page.locator("#reminderEveningTime").inputValue(), "21:15");
  assert.equal(await page.locator("#reminderEvening").isChecked(), false);
  pass("countdown lead days and evening reminder round-trip through the RPC");

  // 5. 客户端校验：半截免打扰要被拒绝，且不写入
  await page.locator("#reminderQuietStart").fill("23:00");
  await page.locator("#reminderSave").click();
  await page.waitForFunction(() => /同时/.test(document.querySelector("#reminderStatus")?.textContent || ""));
  assert.match(await page.locator("#reminderStatus").getAttribute("data-tone"), /error/);
  await page.locator("#reminderQuietStart").fill("");
  pass("incomplete quiet hours are rejected before the RPC");

  // 6. 配对码生成与倒计时显示
  assert.equal(await page.locator("#pairingCodeBox").isHidden(), true);
  await page.locator("#reminderPairButton").click();
  await page.locator("#pairingCodeBox").waitFor({ state: "visible" });
  assert.equal(await page.locator("#pairingCodeDisplay").textContent(), "654321");
  pass("desktop pairing code is generated and rendered");

  // 7. 窄屏下提醒表单不溢出
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await openSettings();
    const overflow = await page.locator(".remind-form").evaluate(node => node.scrollWidth > node.clientWidth + 1);
    assert.equal(overflow, false);
  }
  pass("reminder form fits 390px and 320px without horizontal overflow");

  await browser.close();
  assert.deepEqual(errors, []);
  pass("no browser errors; reminder UI covered end to end");
} catch (error) {
  await browser.close();
  throw error;
} finally {
  server?.kill();
}
