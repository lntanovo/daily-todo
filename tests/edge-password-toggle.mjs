import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runRegistrationChecks } from "./edge-registration-checks.mjs";

const pageUrl = process.env.TODO_TEST_URL || "http://127.0.0.1:5173/";
const edgeCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next standard Edge installation path.
    }
  }
  throw new Error("没有找到 Microsoft Edge。请确认 Edge 已安装。");
}

async function waitForJson(url, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Edge may still be starting.
    }
    await delay(100);
  }
  throw new Error(`等待 Edge 调试接口超时：${url}`);
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const exceptions = [];
  let nextId = 0;

  const opened = new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("无法连接 Edge 调试接口。")), { once: true });
  });

  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails.text || "页面脚本异常");
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolveMessage, rejectMessage } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectMessage(new Error(message.error.message));
    else resolveMessage(message.result);
  });

  async function send(method, params = {}) {
    await opened;
    const id = ++nextId;
    return new Promise((resolveMessage, rejectMessage) => {
      pending.set(id, { resolveMessage, rejectMessage });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Edge 页面求值失败。");
    }
    return result.result.value;
  }

  return { socket, send, evaluate, exceptions };
}

function assertState(condition, message) {
  if (!condition) throw new Error(message);
}

const edgePath = await firstExisting(edgeCandidates);
const profileDir = await mkdtemp(join(tmpdir(), "daily-todo-edge-"));
const resolvedTemp = resolve(tmpdir());
const resolvedProfile = resolve(profileDir);
if (!resolvedProfile.startsWith(`${resolvedTemp}\\`)) {
  throw new Error("临时 Edge 配置目录不在系统临时目录中，已停止测试。");
}

const debugPort = 9300 + Math.floor(Math.random() * 400);
const edge = spawn(edgePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { stdio: "ignore", windowsHide: true });

let cdp;
try {
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  const targetResponse = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  if (!targetResponse.ok) throw new Error("Edge 无法创建测试页面。");
  const target = await targetResponse.json();
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: pageUrl });

  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pageState = await cdp.evaluate(`(() => {
      if (document.getElementById("passwordToggle")?.dataset.visibilityReady === "true") return "ready";
      const riskContinue = document.getElementById("submitBtn");
      if (document.title === "风险提醒" && riskContinue) {
        riskContinue.click();
        return "risk-confirmed";
      }
      return "waiting";
    })()`);
    if (pageState === "ready") {
      ready = true;
      break;
    }
    await delay(100);
  }
  if (!ready) {
    const diagnostic = await cdp.evaluate(`({
      url: location.href,
      title: document.title,
      body: document.body?.innerText.slice(0, 160) || "",
      controls: Array.from(document.querySelectorAll("a, button")).map(item => ({
        text: item.textContent.trim(),
        href: item.href || "",
        id: item.id,
        className: item.className,
      })),
    })`);
    throw new Error(`登录页没有出现固定密码按钮：${JSON.stringify(diagnostic)}`);
  }

  const initial = await cdp.evaluate(`(() => {
    const input = document.getElementById("loginPassword");
    const button = document.getElementById("passwordToggle");
    const inputRect = input.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      type: input.type,
      pressed: button.getAttribute("aria-pressed"),
      label: button.getAttribute("aria-label"),
      showHidden: document.getElementById("passwordShowIcon").hidden,
      hideHidden: document.getElementById("passwordHideIcon").hidden,
      width: buttonRect.width,
      height: buttonRect.height,
      rightGap: Math.abs(inputRect.right - buttonRect.right),
      display: style.display,
      visibility: style.visibility,
      headline: document.getElementById("authTitle").innerText.replace(/\\s+/g, " ").trim(),
      credit: document.querySelector(".auth-credit")?.textContent.trim(),
      hasOldCopy: document.body.innerText.includes("One account, every device"),
      hasThemeButton: Boolean(document.getElementById("themeButton")),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      hasMotionButton: Boolean(document.getElementById("motionButton")),
      companionExists: Boolean(document.querySelector(".companion-layer .companion-sprite")),
      companionHiddenAtLogin: document.querySelector(".companion-layer")?.hidden,
    };
  })()`);

  assertState(initial.type === "password", "初始状态不是隐藏密码。");
  assertState(initial.pressed === "false" && initial.label === "显示密码", "初始按钮辅助文字不正确。");
  assertState(!initial.showHidden && initial.hideHidden, `初始眼睛图标不正确：${JSON.stringify(initial)}`);
  assertState(initial.width === 44 && initial.height === 44, "固定按钮点击区域不是 44×44 像素。");
  assertState(initial.rightGap <= 3 && initial.display !== "none" && initial.visibility !== "hidden", "眼睛按钮没有固定在输入框右侧。");
  assertState(initial.headline === "MAKE TODAY COUNT 让今天算数", `登录标题不正确：${initial.headline}`);
  assertState(initial.credit === "made by lntano", "作者署名没有正确显示。");
  assertState(!initial.hasOldCopy, "登录页仍显示已删除的说明文字。");
  assertState(!initial.hasThemeButton && initial.bodyBackground === "rgb(243, 235, 221)", "页面没有固定为暖色纸张主题。");
  assertState(initial.hasMotionButton && initial.companionExists && initial.companionHiddenAtLogin, "宠物动效入口没有加载，或登录页错误显示了宠物。");

  const motionPreference = await cdp.evaluate(`(() => {
    const button = document.getElementById('motionButton');
    button.click();
    const off = { pressed: button.getAttribute('aria-pressed'), stored: localStorage.getItem('daily-todo.motion.v1'), mode: document.documentElement.dataset.motion };
    button.click();
    return { off, on: { pressed: button.getAttribute('aria-pressed'), stored: localStorage.getItem('daily-todo.motion.v1'), mode: document.documentElement.dataset.motion } };
  })()`);
  assertState(motionPreference.off.pressed === "false" && motionPreference.off.stored === "off" && motionPreference.off.mode === "off", "关闭动效没有正确保存。")
  assertState(motionPreference.on.pressed === "true" && motionPreference.on.stored === "on" && motionPreference.on.mode === "on", "重新开启动效没有正确保存。")

  const taskControls = await cdp.evaluate(`(() => {
    const dialog = document.getElementById('taskDialog');
    dialog.showModal();
    const normal = document.querySelector('input[name="taskPriority"][value="normal"]');
    const urgent = document.querySelector('input[name="taskPriority"][value="urgent"]');
    const normalColor = getComputedStyle(normal.nextElementSibling).backgroundColor;
    urgent.click();
    const urgentColor = getComputedStyle(urgent.nextElementSibling).backgroundColor;
    document.getElementById('taskTitle').value = '时间校验';
    document.getElementById('taskStartTime').value = '10:00';
    document.getElementById('taskEndTime').value = '09:00';
    document.getElementById('taskForm').requestSubmit();
    const result = {
      normalColor,
      urgentColor,
      timeInputs: [document.getElementById('taskStartTime').type, document.getElementById('taskEndTime').type],
      error: document.getElementById('formError').textContent,
    };
    dialog.close();
    return result;
  })()`);
  assertState(taskControls.normalColor === "rgb(47, 111, 159)", "普通优先级没有使用蓝色。");
  assertState(taskControls.urgentColor === "rgb(184, 58, 47)", "紧急优先级没有使用红色。");
  assertState(taskControls.timeInputs.every(type => type === "time") && taskControls.error.includes("晚于"), "每日时间段控件或校验没有生效。");

  for (const width of [1440, 320]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(50);
    const layout = await cdp.evaluate(`(() => {
      const titleRect = document.getElementById("authTitle").getBoundingClientRect();
      const creditRect = document.querySelector(".auth-credit").getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        titleLeft: titleRect.left,
        titleRight: titleRect.right,
        creditLeft: creditRect.left,
        creditRight: creditRect.right,
      };
    })()`);
    assertState(layout.pageWidth <= layout.viewportWidth, `${width}px 宽度下页面发生横向溢出。`);
    assertState(layout.titleLeft >= 0 && layout.titleRight <= layout.viewportWidth, `${width}px 宽度下标题越出屏幕。`);
    assertState(layout.creditLeft >= 0 && layout.creditRight <= layout.viewportWidth, `${width}px 宽度下署名越出屏幕。`);
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  const shown = await cdp.evaluate(`(() => {
    const input = document.getElementById("loginPassword");
    const button = document.getElementById("passwordToggle");
    input.value = "edge-test-password";
    button.click();
    return {
      type: input.type,
      value: input.value,
      pressed: button.getAttribute("aria-pressed"),
      label: button.getAttribute("aria-label"),
      showHidden: document.getElementById("passwordShowIcon").hidden,
      hideHidden: document.getElementById("passwordHideIcon").hidden,
    };
  })()`);

  assertState(shown.type === "text" && shown.value === "edge-test-password", "点击后没有正确显示密码。");
  assertState(shown.pressed === "true" && shown.label === "隐藏密码", "显示状态的辅助文字不正确。");
  assertState(shown.showHidden && !shown.hideHidden, "显示状态的图标没有切换。");

  const hidden = await cdp.evaluate(`(() => {
    const input = document.getElementById("loginPassword");
    const button = document.getElementById("passwordToggle");
    button.click();
    return {
      type: input.type,
      value: input.value,
      pressed: button.getAttribute("aria-pressed"),
      label: button.getAttribute("aria-label"),
    };
  })()`);

  assertState(hidden.type === "password" && hidden.value === "edge-test-password", "再次点击后没有正确隐藏密码。");
  assertState(hidden.pressed === "false" && hidden.label === "显示密码", "隐藏状态的辅助文字不正确。");
  await runRegistrationChecks(cdp);
  assertState(cdp.exceptions.length === 0, `发现页面脚本异常：${cdp.exceptions.join("；")}`);

  console.log("Edge 登录页测试通过：新标题和署名显示正确，旧说明已删除，1440/320px 无溢出，眼睛按钮显隐正常。");
} finally {
  try {
    if (cdp) await cdp.send("Browser.close");
  } catch {
    edge.kill();
  }
  await delay(300);
  edge.kill();
  await rm(profileDir, { recursive: true, force: true });
}
