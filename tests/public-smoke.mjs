import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const runtime = process.env.PLAYWRIGHT_MODULE || "C:/Users/lntano/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(runtime));
const url = process.env.PUBLIC_URL || "https://daily-todo-d3gq5mama7a468d02-1485775300.tcloudbaseapp.com/?v=1.4.0-20261008";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const failedAssets = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.url().includes("/assets/") && response.status() >= 400) failedAssets.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const confirm = page.getByText("确定访问", { exact: false });
  if (await confirm.count()) await confirm.first().click();
  await page.waitForFunction(() => {
    const button = document.querySelector("#loginButton");
    return Boolean(button && !button.disabled);
  }, null, { timeout: 60_000 });
  assert.equal(await page.locator("#quickAddForm").count(), 1);
  assert.equal(await page.locator("#backupExportButton").count(), 1);
  await page.locator("#loginPassword").fill("preview-only");
  await page.locator("#passwordToggle").click();
  assert.equal(await page.locator("#loginPassword").getAttribute("type"), "text");
  assert.deepEqual(failedAssets, []);
  assert.deepEqual(errors, []);
  console.log("PASS 公网 v1.4.0 登录初始化、关键入口、密码显隐、静态资源及脚本错误检查");
} finally {
  await browser.close();
}
