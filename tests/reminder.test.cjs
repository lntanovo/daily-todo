const { test } = require("node:test");
const assert = require("node:assert/strict");

const core = require("../cloudfunctions/reminder-tick/core");
const done = require("../cloudfunctions/reminder-done");

const FEISHU = "https://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234";
const WECOM = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd-1234";

function fakeRpc(handlers = {}) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (Object.prototype.hasOwnProperty.call(handlers, name)) {
      return handlers[name](args, calls);
    }
    if (name === "reminder_claim") return true;
    if (name === "reminder_mark") return true;
    if (name === "reminder_token_issue") return true;
    if (name === "reminder_purge") return { logs: 0, tokens: 0 };
    return [];
  };
  return { rpc, calls };
}

function fakeFetch(responses = []) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const next = responses.length ? responses.shift() : { body: { code: 0, errcode: 0 } };
    return {
      ok: next.status ? next.status < 400 : true,
      status: next.status || 200,
      text: async () => JSON.stringify(next.body)
    };
  };
  return { fetchImpl, calls };
}

const silent = () => {};

test("feishu and wecom URLs are restricted to official bot endpoints", () => {
  assert.equal(core.webhookAllowed("feishu", FEISHU), true);
  assert.equal(core.webhookAllowed("feishu", "https://open.larksuite.com/open-apis/bot/v2/hook/x1"), true);
  assert.equal(core.webhookAllowed("wecom", WECOM), true);

  assert.equal(core.webhookAllowed("feishu", "http://open.feishu.cn/open-apis/bot/v2/hook/x"), false);
  assert.equal(core.webhookAllowed("feishu", "https://evil.example/open-apis/bot/v2/hook/x"), false);
  assert.equal(core.webhookAllowed("feishu", "https://open.feishu.cn.evil.example/open-apis/bot/v2/hook/x"), false);
  assert.equal(core.webhookAllowed("wecom", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a&to=b"), false);
  assert.equal(core.webhookAllowed("wecom", ""), false);
  assert.equal(core.webhookAllowed("other", WECOM), false);
});

test("deliveryOk reads business codes, not just HTTP status", () => {
  assert.equal(core.deliveryOk("feishu", { code: 0 }), true);
  assert.equal(core.deliveryOk("feishu", { code: 19001 }), false);
  assert.equal(core.deliveryOk("feishu", { StatusCode: 0 }), true);
  assert.equal(core.deliveryOk("wecom", { errcode: 0 }), true);
  assert.equal(core.deliveryOk("wecom", { errcode: 93000 }), false);
  assert.equal(core.deliveryOk("wecom", null), false);
});

test("cards carry a plain-text title and a completion button link", () => {
  const payload = core.feishuCard({ title: "交报告", body: "时间到了：18:00", link: "https://x.test/api/reminder/done?t=abc" });
  assert.equal(payload.msg_type, "interactive");
  assert.equal(payload.card.header.title.content, "交报告");
  const action = payload.card.elements.find(element => element.tag === "action");
  assert.equal(action.actions[0].url, "https://x.test/api/reminder/done?t=abc");
});

test("markdown payloads are escaped as text and never emit HTML", () => {
  const payload = core.feishuPost({ title: "<script>", body: "a < b", link: null });
  const text = payload.content.post.zh_cn.content[0][0].text;
  assert.equal(payload.content.post.zh_cn.title, "<script>");
  assert.ok(!/标记完成/.test(text));
});

test("completion links are absolute and never built from a missing base", () => {
  assert.equal(core.completionLink("", "abc"), null);
  assert.equal(core.completionLink("not a url", "abc"), null);
  const link = new URL(core.completionLink("https://todo.example", "abc"));
  assert.equal(link.origin, "https://todo.example");
  assert.equal(link.pathname, "/api/reminder/done");
  assert.equal(link.searchParams.get("t"), "abc");
});

test("tokens are 32 random bytes, stored only as a hash", () => {
  const first = core.newToken();
  const second = core.newToken();
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.hash, first.token);
  assert.notEqual(first.token, second.token);
});

test("digest body renders today, overdue and countdown sections", () => {
  const body = core.describeDigest({
    today: [
      { id: "t1", time: "07:30", title: "起床", urgent: false },
      { id: "t2", time: "23:59", title: "交报告", urgent: true }
    ],
    overdue: [{ id: "t3", date: "2026-11-14", title: "交实验报告2", days: -2, urgent: false }],
    countdown: [
      { id: "t4", date: "2026-11-17", time: "10:00", title: "高数小测", days: 1, urgent: false },
      { id: "t5", date: "2026-11-19", time: "", title: "编译原理作业", days: 3, urgent: false }
    ]
  });
  assert.equal(
    body,
    [
      "**今天 2 项**",
      "07:30 起床",
      "23:59 **交报告**",
      "",
      "**⚠️ 逾期 1 项**",
      "11-14 交实验报告2（逾期 2 天）",
      "",
      "**⏳ 倒计时**",
      "明天 高数小测（11-17 10:00）",
      "3 天后 编译原理作业（11-19）"
    ].join("\n")
  );
});

test("an empty digest says something different in the evening", () => {
  assert.equal(core.describeDigest({ today: [], overdue: [], countdown: [] }), "今天没有待办。");
  assert.equal(core.describeDigest({ today: [], overdue: [], countdown: [] }, "pm"), "今天没有剩余待办。");
  assert.equal(core.describeDigest({}), "今天没有待办。");
});

test("digest sections arrive as JSON text or an object, and legacy tasks still render", () => {
  const fromText = core.describeDigest(JSON.parse('{"today":[{"time":"08:00","title":"预习"}],"overdue":[],"countdown":[]}'));
  assert.match(fromText, /预习/);
  assert.match(core.describeDigest(core.sectionsOf({ tasks: [{ time: "08:00", title: "旧格式" }] })), /08:00 旧格式/);
  assert.equal(core.sectionsOf({ sections: "not json" }), null);
  assert.equal(core.sectionsOf({}), null);
});

test("task body prefers the database clock and fills the fallback", () => {
  assert.equal(
    core.describeTask({ remind_clock: "18:30", remind_at: "2026-11-05T10:30:00Z" }),
    "时间到了：18:30"
  );
  assert.equal(core.describeTask({ remind_clock: "", remind_at: "2026-11-05T10:30:00Z" }), "时间到了：18:30");
  assert.equal(core.describeTask({}), "时间到了");
});

test("a due task sends once per channel and records success", async () => {
  const dueRow = {
    owner_id: "owner-1", task_id: "task-1", task_title: "交报告",
    remind_date: "2026-11-05", remind_at: "2026-11-05T10:00:00Z",
    quiet_active: false, feishu_webhook: FEISHU, wecom_webhook: null
  };
  const { rpc, calls } = fakeRpc({ reminder_due_batch: () => [dueRow], reminder_digest_batch: () => [] });
  const { fetchImpl, calls: sends } = fakeFetch([{ body: { code: 0 } }]);

  const summary = await core.tick({
    rpc, fetchImpl, baseUrl: "https://todo.example", format: "card",
    log: silent, now: "2026-11-05T10:00:05Z"
  });

  assert.equal(summary.due, 1);
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 0);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, FEISHU);

  const names = calls.map(call => call.name);
  assert.ok(names.includes("reminder_claim"));
  assert.ok(names.includes("reminder_token_issue"));
  assert.ok(names.includes("reminder_mark"));
  const mark = calls.find(call => call.name === "reminder_mark");
  assert.equal(mark.args.p_status, "sent");
  assert.equal(mark.args.p_kind, "task");
});

test("a duplicate claim never sends a second message", async () => {
  const dueRow = {
    owner_id: "owner-1", task_id: "task-1", task_title: "交报告",
    remind_date: "2026-11-05", remind_at: "2026-11-05T10:00:00Z",
    quiet_active: false, feishu_webhook: FEISHU, wecom_webhook: null
  };
  const { rpc } = fakeRpc({
    reminder_due_batch: () => [dueRow],
    reminder_digest_batch: () => [],
    reminder_claim: () => false
  });
  const { fetchImpl, calls: sends } = fakeFetch();

  const summary = await core.tick({
    rpc, fetchImpl, baseUrl: "https://todo.example", format: "card",
    log: silent, now: "2026-11-05T10:00:05Z"
  });

  assert.equal(sends.length, 0);
  assert.equal(summary.duplicate, 1);
  assert.equal(summary.sent, 0);
});

test("quiet hours are recorded as skipped and never delivered", async () => {
  const dueRow = {
    owner_id: "owner-1", task_id: "task-1", task_title: "交报告",
    remind_date: "2026-11-05", remind_at: "2026-11-05T10:00:00Z",
    quiet_active: true, feishu_webhook: FEISHU, wecom_webhook: null
  };
  const { rpc, calls } = fakeRpc({ reminder_due_batch: () => [dueRow], reminder_digest_batch: () => [] });
  const { fetchImpl, calls: sends } = fakeFetch();

  await core.tick({
    rpc, fetchImpl, baseUrl: "https://todo.example", format: "card",
    log: silent, now: "2026-11-05T10:00:05Z"
  });

  assert.equal(sends.length, 0);
  const mark = calls.find(call => call.name === "reminder_mark");
  assert.equal(mark.args.p_status, "skipped");
});

test("business-code failure is retried later, so it is recorded as failed", async () => {
  const dueRow = {
    owner_id: "owner-1", task_id: "task-1", task_title: "交报告",
    remind_date: "2026-11-05", remind_at: "2026-11-05T10:00:00Z",
    quiet_active: false, feishu_webhook: FEISHU, wecom_webhook: null
  };
  const { rpc, calls } = fakeRpc({ reminder_due_batch: () => [dueRow], reminder_digest_batch: () => [] });
  const { fetchImpl } = fakeFetch([{ status: 200, body: { code: 19001 } }]);

  const summary = await core.tick({
    rpc, fetchImpl, baseUrl: "https://todo.example", format: "card",
    log: silent, now: "2026-11-05T10:00:05Z"
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 0);
  const mark = calls.find(call => call.name === "reminder_mark");
  assert.equal(mark.args.p_status, "failed");
  assert.equal(mark.args.p_error, "feishu_19001");
});

test("a network throw still records failure instead of leaving a stale claim", async () => {
  const dueRow = {
    owner_id: "owner-1", task_id: "task-1", task_title: "交报告",
    remind_date: "2026-11-05", remind_at: "2026-11-05T10:00:00Z",
    quiet_active: false, feishu_webhook: FEISHU, wecom_webhook: null
  };
  const { rpc, calls } = fakeRpc({ reminder_due_batch: () => [dueRow], reminder_digest_batch: () => [] });
  const fetchImpl = async () => { throw new Error("timeout"); };

  const summary = await core.tick({
    rpc, fetchImpl, baseUrl: "https://todo.example", format: "card",
    log: silent, now: "2026-11-05T10:00:05Z"
  });

  assert.equal(summary.failed, 1);
  const mark = calls.find(call => call.name === "reminder_mark");
  assert.equal(mark.args.p_status, "failed");
  assert.equal(mark.args.p_error, "timeout");
});

test("digest sends one message per account and never creates a token", async () => {
  const { rpc, calls } = fakeRpc({
    reminder_due_batch: () => [],
    reminder_digest_batch: args => (args.p_slot === "am" ? [{
      owner_id: "owner-1",
      remind_date: "2026-11-05",
      sections: {
        today: [{ id: "t1", time: "08:00", title: "预习", urgent: false }],
        overdue: [],
        countdown: []
      },
      quiet_active: false,
      feishu_webhook: FEISHU,
      wecom_webhook: WECOM
    }] : [])
  });
  const { fetchImpl, calls: sends } = fakeFetch([{ body: { code: 0 } }, { body: { errcode: 0 } }]);

  const summary = await core.tick({
    rpc, fetchImpl, baseUrl: "https://todo.example", format: "card",
    log: silent, now: "2026-11-05T00:00:30Z"
  });

  assert.equal(summary.digests, 1);
  assert.equal(summary.digest_am, 1);
  assert.equal(summary.digest_pm, 0);
  assert.equal(summary.sent, 2);
  assert.equal(sends.length, 2);
  assert.ok(!calls.some(call => call.name === "reminder_token_issue"));
  const digestClaim = calls.find(call => call.name === "reminder_claim" && call.args.p_kind === "digest");
  assert.equal(digestClaim.args.p_ref_id, "digest");
  // 两次汇总查询必须带上 slot，否则晚间收尾会拿早报的数据再发一遍。
  const slots = calls.filter(call => call.name === "reminder_digest_batch").map(call => call.args.p_slot);
  assert.deepEqual(slots, ["am", "pm"]);
});

test("the evening digest uses its own ledger kind and title", async () => {
  const { rpc, calls } = fakeRpc({
    reminder_due_batch: () => [],
    reminder_digest_batch: args => (args.p_slot === "pm" ? [{
      owner_id: "owner-1",
      remind_date: "2026-11-05",
      sections: {
        today: [{ id: "t1", time: "23:59", title: "交报告", urgent: false }],
        overdue: [{ id: "t2", date: "2026-11-03", title: "交作业", days: -2, urgent: false }],
        countdown: []
      },
      quiet_active: false,
      feishu_webhook: FEISHU,
      wecom_webhook: null
    }] : [])
  });
  const { fetchImpl, calls: sends } = fakeFetch([{ body: { code: 0 } }]);

  const summary = await core.tick({
    rpc, fetchImpl, baseUrl: "https://todo.example", format: "card",
    log: silent, now: "2026-11-05T12:30:30Z"
  });

  assert.equal(summary.digest_pm, 1);
  const claim = calls.find(call => call.name === "reminder_claim" && call.args.p_kind === "digest_pm");
  assert.equal(claim.args.p_ref_id, "digest_pm");
  assert.match(sends[0].body.card.header.title.content, /今晚收尾（2 项未完成）/);
  const text = sends[0].body.card.elements[0].text.content;
  assert.match(text, /逾期 1 项/);
  assert.match(text, /交报告/);
});

test("completion link page escapes task titles", () => {
  const html = done.page(done.viewFor({ ok: true, title: "<img onerror=1>", date: "2026-11-05" }));
  assert.ok(!html.includes("<img onerror"));
  assert.ok(html.includes("&lt;img onerror=1&gt;"));
});

test("expired and invalid completion tokens map to distinct pages", () => {
  assert.equal(done.viewFor({ ok: false, code: "EXPIRED" }).status, 410);
  assert.equal(done.viewFor({ ok: false, code: "INVALID" }).status, 400);
  assert.equal(done.viewFor({ ok: true, already: true }).status, 200);
  assert.equal(done.viewFor({ ok: true, skipped: "removed" }).headline, "这一项已经删除");
});
