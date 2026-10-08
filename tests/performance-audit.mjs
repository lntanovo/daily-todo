import { mkdir } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

const runtime = process.env.PLAYWRIGHT_MODULE || "C:/Users/lntano/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(runtime));
const url = process.env.AUDIT_URL || "http://127.0.0.1:5193/tests/features-fixture.html";
const label = process.env.AUDIT_LABEL || "audit";
const runs = Math.max(1, Number(process.env.AUDIT_RUNS || 3));
const screenshot = process.env.AUDIT_SCREENSHOT === "1";
const artifacts = fileURLToPath(new URL("./artifacts/", import.meta.url));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(browser, iteration) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__audit = { lcp: 0, cls: 0, interaction: 0 };
    new PerformanceObserver(list => {
      const entries = list.getEntries();
      window.__audit.lcp = entries.at(-1)?.startTime || window.__audit.lcp;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__audit.cls += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
    if (PerformanceObserver.supportedEntryTypes.includes("event")) {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__audit.interaction = Math.max(window.__audit.interaction, entry.duration || 0);
      }).observe({ type: "event", buffered: true, durationThreshold: 16 });
    }
  });
  if (url.includes("tcloudbaseapp.com")) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const confirmAccess = page.getByText("确定访问", { exact: false });
    if (await confirmAccess.count()) {
      await confirmAccess.first().click();
      await page.waitForLoadState("domcontentloaded");
    }
  }
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: 1_600_000 / 8,
    uploadThroughput: 750_000 / 8,
    connectionType: "cellular4g"
  });
  const requests = new Map();
  session.on("Network.responseReceived", event => {
    requests.set(event.requestId, {
      type: event.type,
      url: event.response.url,
      fromCache: event.response.fromDiskCache || event.response.fromPrefetchCache || event.response.fromServiceWorker,
      bytes: 0
    });
  });
  session.on("Network.loadingFinished", event => {
    const request = requests.get(event.requestId);
    if (request) request.bytes = event.encodedDataLength || 0;
  });
  await page.goto(`${url}${url.includes("?") ? "&" : "?"}audit=${Date.now()}-${iteration}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const isFixture = url.includes("features-fixture");
  if (isFixture) await page.waitForFunction(() => document.querySelector("#appRoot")?.getAttribute("aria-busy") === "false", null, { timeout: 60_000 });
  else {
    await page.waitForFunction(() => {
      const button = document.querySelector("#loginButton");
      const message = document.querySelector("#authMessage")?.textContent || "";
      return Boolean(button && !button.disabled) || message.includes("云端客户端加载失败") || message.includes("前端配置不完整");
    }, null, { timeout: 60_000 });
    const bootFailure = await page.locator("#authMessage").textContent();
    if (/云端客户端加载失败|前端配置不完整/.test(bootFailure || "")) throw new Error(`公网登录初始化失败：${bootFailure}`);
  }
  await page.waitForTimeout(1500);
  if (isFixture) await page.locator("#quoteNextButton").click();
  else if (await page.locator("#passwordToggle").count()) await page.locator("#passwordToggle").click();
  await page.waitForTimeout(250);
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map(entry => [entry.name, entry.startTime]));
    return {
      domContentLoaded: navigation?.domContentLoadedEventEnd || 0,
      load: navigation?.loadEventEnd || 0,
      fcp: paint["first-contentful-paint"] || 0,
      ...window.__audit
    };
  });
  const resources = [...requests.values()].filter(item => !item.fromCache && item.bytes > 0);
  const byType = {};
  for (const item of resources) byType[item.type] = (byType[item.type] || 0) + item.bytes;
  if (screenshot && iteration === 0) {
    await mkdir(artifacts, { recursive: true });
    await session.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.screenshot({ path: `${artifacts}\\perf-${label}.png`, fullPage: true, timeout: 120_000 });
  }
  await context.close();
  return { ...timing, transferBytes: resources.reduce((sum, item) => sum + item.bytes, 0), requests: resources.length, byType };
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const samples = [];
  for (let index = 0; index < runs; index += 1) samples.push(await measure(browser, index));
  const keys = ["domContentLoaded", "load", "fcp", "lcp", "cls", "interaction", "transferBytes", "requests"];
  const summary = Object.fromEntries(keys.map(key => [key, median(samples.map(sample => sample[key]))]));
  summary.transferKiB = Number((summary.transferBytes / 1024).toFixed(1));
  console.log(JSON.stringify({ label, url, profile: "390x844, cold cache, 150ms RTT, 1.6Mbps down, 0.75Mbps up", samples, median: summary }, null, 2));
} finally {
  await browser.close();
}
