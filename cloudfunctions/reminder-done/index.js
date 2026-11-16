"use strict";

const { createHash } = require("node:crypto");

const TOKEN_RE = /^[a-f0-9]{64}$/;

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function page({ status, title, headline, detail, backUrl }) {
  const safeBack = typeof backUrl === "string" && /^https:\/\//.test(backUrl) ? backUrl : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f3ebdd; color: #1f1c18; padding: 24px;
    font: 16px/1.7 "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  }
  main { width: min(520px, 100%); }
  .kicker { margin: 0 0 10px; color: #b2492d; font-size: 12px; font-weight: 700; letter-spacing: .18em; }
  h1 { margin: 0 0 14px; font: 700 32px/1.25 Georgia, "Microsoft YaHei", serif; }
  p { margin: 0 0 10px; color: #4f473e; }
  .detail { padding-top: 14px; border-top: 1px solid #b9ad9a; font-size: 14px; }
  a { display: inline-block; margin-top: 20px; padding: 12px 20px; border-radius: 999px; background: #b2492d; color: #f3ebdd; text-decoration: none; }
</style>
</head>
<body>
<main>
  <p class="kicker">DAILY TODO / 日程安排</p>
  <h1>${escapeHtml(headline)}</h1>
  <p>${escapeHtml(detail)}</p>
  ${safeBack ? `<p class="detail"><a href="${escapeHtml(safeBack)}">回到日程</a></p>` : ""}
</main>
</body>
</html>`;
}

function respond(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow"
    },
    body
  };
}

function viewFor(result) {
  if (!result || typeof result !== "object") {
    return { status: 502, title: "暂时无法确认", headline: "链接暂时打不开", detail: "请稍后重试，或打开日程安排手动勾选。" };
  }
  if (result.ok === false) {
    if (result.code === "EXPIRED") {
      return { status: 410, title: "链接已过期", headline: "这条提醒已过期", detail: "为了安全，完成链接只在有效期内可用。请打开日程安排完成这一项。" };
    }
    return { status: 400, title: "链接无效", headline: "这条链接无效", detail: "它可能已经失效，或不是来自日程安排。请打开网站手动完成。" };
  }
  if (result.skipped === "removed") {
    return { status: 200, title: "事项已删除", headline: "这一项已经删除", detail: "不用再处理了，日程里已经看不到它。" };
  }
  if (result.skipped === "rescheduled") {
    return { status: 200, title: "日期已调整", headline: "这一项已经不在那天", detail: "日期被改过，所以没有标记完成。请打开日程查看。" };
  }
  if (result.already === true) {
    return { status: 200, title: "已经完成", headline: "这一项已经完成", detail: "不用重复操作，日程里已经记录好了。" };
  }
  return {
    status: 200,
    title: "已完成",
    headline: "已完成 ✓",
    detail: `「${String(result.title || "事项")}」已标记为完成${result.date ? `（${String(result.date)}）` : ""}。`
  };
}

exports.main = async (event = {}) => {
  const isHttp = typeof event?.httpMethod === "string";
  if (!isHttp) return { ok: false, code: "HTTP_ONLY" };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return respond(page({ title: "不支持", headline: "只支持 GET", detail: "请从提醒消息里的按钮打开。" }), 405);
  }

  const query = event.queryStringParameters || event.queryString || {};
  const token = String(query.t || "");

  if (!TOKEN_RE.test(token)) {
    const view = viewFor({ ok: false, code: "INVALID" });
    return respond(page(view), view.status);
  }

  const envId = process.env.APP_ENV_ID;
  const apiKey = process.env.CLOUDBASE_API_KEY;
  if (!envId || !apiKey) {
    console.error(JSON.stringify({ event: "missing_configuration" }));
    const view = viewFor(null);
    return respond(page(view), view.status);
  }

  try {
    const response = await fetch(
      `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/reminder_complete_by_token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_token_hash: createHash("sha256").update(token).digest("hex") }),
        signal: AbortSignal.timeout(12000)
      }
    );
    if (!response.ok) throw Object.assign(new Error(`RPC_HTTP_${response.status}`), { code: "RPC_FAILED" });
    const json = await response.json();
    const result = json && Object.prototype.hasOwnProperty.call(json, "data") ? json.data : json;
    const view = viewFor(result);
    return respond(page({ ...view, backUrl: process.env.REMINDER_BASE_URL || "" }), view.status);
  } catch (error) {
    console.error(JSON.stringify({ event: "complete_failed", code: String(error.code || "COMPLETE_FAILED") }));
    const view = viewFor(null);
    return respond(page(view), view.status);
  }
};

exports.page = page;
exports.viewFor = viewFor;
exports.escapeHtml = escapeHtml;
