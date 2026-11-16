"use strict";

const { createHash, randomBytes } = require("node:crypto");

const TIMEZONE = "Asia/Shanghai";
const FEISHU_HOSTS = new Set(["open.feishu.cn", "open.larksuite.com"]);
const WECOM_HOST = "qyapi.weixin.qq.com";

/* ---------------- 纯函数：格式化与校验 ---------------- */

function escapeText(value) {
  return String(value == null ? "" : value);
}

// 只允许发往官方机器人域名。数据库已有正则约束，这里是第二道防线，
// 避免将来迁移或手工改库把任意 URL 变成出站请求。
function webhookAllowed(channel, url) {
  if (typeof url !== "string" || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (channel === "feishu") {
    return FEISHU_HOSTS.has(parsed.hostname) && /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(parsed.pathname);
  }
  if (channel === "wecom") {
    if (parsed.hostname !== WECOM_HOST || parsed.pathname !== "/cgi-bin/webhook/send") return false;
    const keys = [...parsed.searchParams.keys()];
    return keys.length === 1
      && keys[0] === "key"
      && /^[A-Za-z0-9-]+$/.test(parsed.searchParams.get("key") || "");
  }
  return false;
}

function markdownLine(item) {
  const when = item.time ? `${item.time} ` : "";
  return `${when}${item.urgent ? "**" : ""}${escapeText(item.title)}${item.urgent ? "**" : ""}`;
}

// JSONB 经 REST 网关回来时可能是字符串，也可能是已解析的对象。
function sectionsOf(row) {
  const raw = row && row.sections;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object") return raw;
  // 旧版批量函数只给 tasks 数组，保留这条退路，避免滚动发布时静默丢消息。
  if (row && Array.isArray(row.tasks)) return { today: row.tasks, overdue: [], countdown: [] };
  return null;
}

// 只用来显示 MM-DD；数据库已经保证是 YYYY-MM-DD。
function shortDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5) : String(value || "");
}

function feishuCard({ title, body, link }) {
  const elements = [
    { tag: "div", text: { tag: "lark_md", content: escapeText(body) } }
  ];
  if (link) {
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: { tag: "plain_text", content: "标记完成" },
        type: "primary",
        url: link
      }]
    });
  }
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: "orange",
        title: { tag: "plain_text", content: escapeText(title) }
      },
      elements
    }
  };
}

// 自定义机器人若拒绝卡片，可退回已验证过的 post 文本格式。
function feishuPost({ title, body, link }) {
  const text = link ? `${body}\n[标记完成](${link})` : body;
  return {
    msg_type: "post",
    content: {
      post: { zh_cn: { title: escapeText(title), content: [[{ tag: "text", text }]] } }
    }
  };
}

function wecomMarkdown({ title, body, link }) {
  const text = link ? `${body}\n\n[标记完成](${link})` : body;
  return {
    msgtype: "markdown",
    markdown: { content: `## ${escapeText(title)}\n${text}\n\n<font color="comment">日程安排</font>` }
  };
}

function payloadFor(channel, message, format = "card") {
  if (channel === "feishu") {
    return format === "post" ? feishuPost(message) : feishuCard(message);
  }
  if (channel === "wecom") return wecomMarkdown(message);
  throw new Error("UNSUPPORTED_CHANNEL");
}

// 飞书 / 企业微信都可能返回 HTTP 200 但业务码失败，必须解包判断。
function deliveryOk(channel, json) {
  if (!json || typeof json !== "object") return false;
  if (channel === "feishu") return json.code === 0 || json.StatusCode === 0;
  if (channel === "wecom") return json.errcode === 0;
  return false;
}

function newToken() {
  const token = randomBytes(32).toString("hex");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

function completionLink(baseUrl, token) {
  if (!baseUrl) return null;
  try {
    const url = new URL("/api/reminder/done", baseUrl);
    url.searchParams.set("t", token);
    return url.toString();
  } catch {
    return null;
  }
}

function describeTask(row) {
  // 数据库已给出 HH:mm；只有老数据或手工调用才回退到解析时间戳。
  const clock = typeof row.remind_clock === "string" && /^\d{2}:\d{2}$/.test(row.remind_clock)
    ? row.remind_clock
    : row.remind_at
      ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false
        }).format(new Date(row.remind_at))
      : "";
  return clock ? `时间到了：${clock}` : "时间到了";
}

// 一份汇总里最多三段：今天要做的、已经错过的、未来几天的倒计时。
// 逾期与倒计时折进同一条消息，而不是各自单独推送，否则一条作业会在几天里
// 反复轰炸，用户很快就会把整个通知静音。
function describeDigest(sections, slot = "am") {
  const today = Array.isArray(sections?.today) ? sections.today : [];
  const overdue = Array.isArray(sections?.overdue) ? sections.overdue : [];
  const countdown = Array.isArray(sections?.countdown) ? sections.countdown : [];
  const lines = [];

  if (today.length) {
    lines.push(`**今天 ${today.length} 项**`);
    for (const item of today) lines.push(markdownLine(item));
  }

  if (overdue.length) {
    if (lines.length) lines.push("");
    lines.push(`**⚠️ 逾期 ${overdue.length} 项**`);
    for (const item of overdue) {
      const days = Math.max(1, Math.abs(Number(item.days) || 0));
      lines.push(`${shortDate(item.date)} ${escapeText(item.title)}（逾期 ${days} 天）`);
    }
  }

  if (countdown.length) {
    if (lines.length) lines.push("");
    lines.push("**⏳ 倒计时**");
    for (const item of countdown) {
      const days = Number(item.days) || 0;
      const label = days === 1 ? "明天" : `${days} 天后`;
      const clock = item.time ? ` ${item.time}` : "";
      lines.push(`${label} ${escapeText(item.title)}（${shortDate(item.date)}${clock}）`);
    }
  }

  if (!lines.length) return slot === "pm" ? "今天没有剩余待办。" : "今天没有待办。";
  return lines.join("\n");
}

/* ---------------- 云函数主体 ---------------- */

function createRpc({ envId, apiKey, fetchImpl }) {
  return async function rpc(name, args) {
    const response = await fetchImpl(
      `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${name}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(args || {}),
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!response.ok) {
      throw Object.assign(new Error(`RPC_HTTP_${response.status}`), { code: `RPC_HTTP_${response.status}` });
    }
    const json = await response.json();
    // 网关可能返回 { data: ... } 或直接返回函数结果，两种都接受。
    return json && Object.prototype.hasOwnProperty.call(json, "data") ? json.data : json;
  };
}

async function sendOnce({ channel, webhook, message, format, fetchImpl }) {
  const response = await fetchImpl(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payloadFor(channel, message, format)),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `NOT_JSON_${response.status}` };
  }
  if (!response.ok) return { ok: false, error: `HTTP_${response.status}` };
  if (!deliveryOk(channel, json)) {
    const code = json.code ?? json.errcode ?? json.StatusCode ?? "UNKNOWN";
    return { ok: false, error: `${channel}_${code}` };
  }
  return { ok: true, error: null };
}

async function sendAndMark({ rpc, fetchImpl, channel, webhook, message, ownerId, kind, refId, date, log, format }) {
  try {
    const result = await sendOnce({ channel, webhook, message, format, fetchImpl });
    await rpc("reminder_mark", {
      p_owner_id: ownerId,
      p_kind: kind,
      p_ref_id: refId,
      p_remind_date: date,
      p_channel: channel,
      p_status: result.ok ? "sent" : "failed",
      p_error: result.error
    });
    log(result.ok ? "sent" : "failed", {
      owner: ownerId.slice(0, 8), kind, ref: refId, channel, error: result.error
    });
    return { channel, status: result.ok ? "sent" : "failed", error: result.error };
  } catch (error) {
    // 网络异常同样记账，让下一个 tick 在重试上限内继续尝试。
    try {
      await rpc("reminder_mark", {
        p_owner_id: ownerId,
        p_kind: kind,
        p_ref_id: refId,
        p_remind_date: date,
        p_channel: channel,
        p_status: "failed",
        p_error: error.message
      });
    } catch { /* 记账失败也不能掩盖原始错误 */ }
    log("failed", { owner: ownerId.slice(0, 8), kind, ref: refId, channel, error: error.message });
    return { channel, status: "failed", error: error.message };
  }
}

async function claimChannel({ rpc, ownerId, kind, refId, date, channel }) {
  const claimed = await rpc("reminder_claim", {
    p_owner_id: ownerId,
    p_kind: kind,
    p_ref_id: refId,
    p_remind_date: date,
    p_channel: channel
  });
  return claimed === true;
}

async function skipChannel({ rpc, ownerId, kind, refId, date, channel, reason }) {
  await rpc("reminder_mark", {
    p_owner_id: ownerId, p_kind: kind, p_ref_id: refId,
    p_remind_date: date, p_channel: channel,
    p_status: "skipped", p_error: reason
  });
}

function channelsOf(row) {
  const channels = [];
  if (webhookAllowed("feishu", row.feishu_webhook)) channels.push(["feishu", row.feishu_webhook]);
  if (webhookAllowed("wecom", row.wecom_webhook)) channels.push(["wecom", row.wecom_webhook]);
  return channels;
}

async function runDue({ rpc, fetchImpl, baseUrl, format, log, now }) {
  const rows = await rpc("reminder_due_batch", { p_now: now });
  const list = Array.isArray(rows) ? rows : [];
  const results = [];

  for (const row of list) {
    const channels = channelsOf(row);
    if (!channels.length) continue;

    // 先逐个通道抢锁，只有真正抢到的通道才值得发送与建令牌。
    const granted = [];
    for (const [channel, webhook] of channels) {
      if (await claimChannel({
        rpc, ownerId: row.owner_id, kind: "task",
        refId: row.task_id, date: row.remind_date, channel
      })) {
        granted.push([channel, webhook]);
      } else {
        results.push({ channel, status: "duplicate" });
        log("skip_claimed", { owner: row.owner_id.slice(0, 8), ref: row.task_id, channel });
      }
    }
    if (!granted.length) continue;

    if (row.quiet_active === true) {
      for (const [channel] of granted) {
        await skipChannel({
          rpc, ownerId: row.owner_id, kind: "task",
          refId: row.task_id, date: row.remind_date, channel, reason: "quiet hours"
        });
        results.push({ channel, status: "skipped" });
      }
      log("quiet", { ref: row.task_id });
      continue;
    }

    const { token, hash } = newToken();
    const issued = await rpc("reminder_token_issue", {
      p_owner_id: row.owner_id,
      p_task_id: row.task_id,
      p_remind_date: row.remind_date,
      p_token_hash: hash
    });
    const link = issued === true ? completionLink(baseUrl, token) : null;

    const message = {
      title: row.task_title,
      body: describeTask(row),
      link
    };

    for (const [channel, webhook] of granted) {
      results.push(await sendAndMark({
        rpc, fetchImpl, channel, webhook, message,
        ownerId: row.owner_id, kind: "task", refId: row.task_id,
        date: row.remind_date, log, format
      }));
    }
  }

  return { due: list.length, results };
}

async function runDigest({ rpc, fetchImpl, baseUrl, format, log, now, graceMinutes, slot = "am" }) {
  const rows = await rpc("reminder_digest_batch", {
    p_now: now,
    p_grace_minutes: graceMinutes,
    p_slot: slot
  });
  const list = Array.isArray(rows) ? rows : [];
  const results = [];
  // 早报与晚间收尾必须用不同的 kind，否则同一份账本会把第二条判成重复。
  const kind = slot === "pm" ? "digest_pm" : "digest";

  for (const row of list) {
    const sections = sectionsOf(row);
    const today = Array.isArray(sections?.today) ? sections.today : [];
    const overdue = Array.isArray(sections?.overdue) ? sections.overdue : [];
    const channels = channelsOf(row);
    if (!channels.length || !sections) continue;

    // 日期由数据库按上海时区给出，避免云函数运行环境时区不同导致跨日错位。
    const date = typeof row.remind_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.remind_date)
      ? row.remind_date
      : new Intl.DateTimeFormat("en-CA", {
          timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit"
        }).format(new Date(now));

    const granted = [];
    for (const [channel, webhook] of channels) {
      if (await claimChannel({
        rpc, ownerId: row.owner_id, kind,
        refId: kind, date, channel
      })) {
        granted.push([channel, webhook]);
      } else {
        results.push({ channel, status: "duplicate" });
      }
    }
    if (!granted.length) continue;

    if (row.quiet_active === true) {
      for (const [channel] of granted) {
        await skipChannel({
          rpc, ownerId: row.owner_id, kind,
          refId: kind, date, channel, reason: "quiet hours"
        });
        results.push({ channel, status: "skipped" });
      }
      log(slot === "pm" ? "digest_pm_quiet" : "digest_quiet", { owner: row.owner_id.slice(0, 8) });
      continue;
    }

    const message = {
      title: slot === "pm"
        ? `今晚收尾（${today.length + overdue.length} 项未完成）`
        : `今日安排（${today.length} 项）`,
      body: describeDigest(sections, slot),
      link: null
    };

    for (const [channel, webhook] of granted) {
      results.push(await sendAndMark({
        rpc, fetchImpl, channel, webhook, message,
        ownerId: row.owner_id, kind, refId: kind,
        date, log, format
      }));
    }
  }

  return { digests: list.length, results };
}

async function tick({ rpc, fetchImpl, baseUrl, format, log, now = new Date().toISOString(), graceMinutes = 180, purgeDays = 60 }) {
  const due = await runDue({ rpc, fetchImpl, baseUrl, format, log, now });
  const am = await runDigest({ rpc, fetchImpl, baseUrl, format, log, now, graceMinutes, slot: "am" });
  const pm = await runDigest({ rpc, fetchImpl, baseUrl, format, log, now, graceMinutes, slot: "pm" });

  let purged = null;
  try {
    purged = await rpc("reminder_purge", { p_days: purgeDays });
  } catch (error) {
    log("purge_failed", { error: error.message });
  }

  const all = [...due.results, ...am.results, ...pm.results];
  const summary = {
    at: now,
    due: due.due,
    digests: am.digests + pm.digests,
    digest_am: am.digests,
    digest_pm: pm.digests,
    sent: all.filter(item => item.status === "sent").length,
    failed: all.filter(item => item.status === "failed").length,
    duplicate: all.filter(item => item.status === "duplicate").length,
    purged
  };
  log("tick", summary);
  return summary;
}

module.exports = {
  tick,
  runDue,
  runDigest,
  payloadFor,
  deliveryOk,
  webhookAllowed,
  feishuCard,
  feishuPost,
  wecomMarkdown,
  completionLink,
  newToken,
  describeDigest,
  describeTask,
  sectionsOf,
  createRpc,
  sendOnce,
  sendAndMark
};
