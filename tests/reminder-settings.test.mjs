import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReminderSettings, buildReminderPayload, describeSaved } from "../src/reminders.js";

function makeElements(overrides = {}) {
  return {
    feishu: { value: "", placeholder: "" },
    wecom: { value: "", placeholder: "" },
    digest: { checked: true },
    digestTime: { value: "08:00" },
    evening: { checked: true },
    eveningTime: { value: "20:30" },
    leadDays: { value: "3" },
    grace: { value: "60" },
    quietStart: { value: "" },
    quietEnd: { value: "" },
    ...overrides
  };
}

test("saved webhooks are never echoed back, only hinted", () => {
  const elements = makeElements();
  applyReminderSettings(elements, {
    feishu_set: true, feishu_hint: "…ab12",
    wecom_set: false, wecom_hint: "",
    digest_enabled: true, digest_time: "07:30", grace_minutes: 45,
    quiet_start: "23:00", quiet_end: "07:00"
  });
  assert.equal(elements.feishu.value, "");
  assert.match(elements.feishu.placeholder, /…ab12/);
  assert.doesNotMatch(elements.feishu.placeholder, /https/);
  assert.equal(elements.digestTime.value, "07:30");
  assert.equal(elements.grace.value, "45");
  assert.equal(elements.quietStart.value, "23:00");
});

test("empty webhook inputs leave stored values untouched", () => {
  const payload = buildReminderPayload(makeElements());
  assert.equal(payload.feishu_webhook, undefined);
  assert.equal(payload.wecom_webhook, undefined);
  assert.equal(payload.grace_minutes, 60);
  assert.equal(payload.digest_enabled, true);
});

test("a single dash clears a channel explicitly", () => {
  const elements = makeElements();
  elements.feishu.value = "-";
  assert.equal(buildReminderPayload(elements).feishu_webhook, "");
});

test("new webhooks must be https, otherwise the save is rejected before RPC", () => {
  const elements = makeElements();
  elements.feishu.value = "http://open.feishu.cn/open-apis/bot/v2/hook/x";
  assert.throws(() => buildReminderPayload(elements), /https/);
});

test("quiet hours must be a complete, non-equal pair", () => {
  const half = makeElements();
  half.quietStart.value = "23:00";
  assert.throws(() => buildReminderPayload(half), /同时/);

  const equal = makeElements();
  equal.quietStart.value = "09:00";
  equal.quietEnd.value = "09:00";
  assert.throws(() => buildReminderPayload(equal), /不能相同/);

  const ok = makeElements();
  ok.quietStart.value = "23:30";
  ok.quietEnd.value = "07:00";
  assert.equal(buildReminderPayload(ok).quiet_end, "07:00");
});

test("grace minutes outside 0-1440 are rejected", () => {
  const elements = makeElements();
  elements.grace.value = "1441";
  assert.throws(() => buildReminderPayload(elements), /0—1440/);
  elements.grace.value = "abc";
  assert.throws(() => buildReminderPayload(elements), /0—1440/);
});

test("summary states whether any channel is configured", () => {
  assert.match(describeSaved({ feishu_set: false, wecom_set: false }), /还没有推送通道/);
  assert.match(describeSaved({ feishu_set: true, feishu_hint: "…ab12", wecom_set: false }), /飞书 …ab12/);
});

test("countdown and evening settings round-trip through the form", () => {
  const elements = makeElements();
  applyReminderSettings(elements, {
    digest_enabled: true, digest_time: "07:30",
    evening_enabled: false, evening_time: "21:15",
    remind_lead_days: 5, grace_minutes: 45
  });
  assert.equal(elements.leadDays.value, "5");
  assert.equal(elements.evening.checked, false);
  assert.equal(elements.eveningTime.value, "21:15");

  const payload = buildReminderPayload(elements);
  assert.equal(payload.remind_lead_days, 5);
  assert.equal(payload.evening_enabled, false);
  assert.equal(payload.evening_time, "21:15");
});

test("missing countdown settings fall back to the documented defaults", () => {
  const elements = makeElements();
  applyReminderSettings(elements, { digest_enabled: true, digest_time: "08:00", grace_minutes: 60 });
  assert.equal(elements.leadDays.value, "3");
  assert.equal(elements.evening.checked, true);
  assert.equal(elements.eveningTime.value, "20:30");
});

test("countdown days outside 0-30 are rejected before the RPC", () => {
  const high = makeElements();
  high.leadDays.value = "31";
  assert.throws(() => buildReminderPayload(high), /0—30/);

  const text = makeElements();
  text.leadDays.value = "abc";
  assert.throws(() => buildReminderPayload(text), /0—30/);

  const zero = makeElements();
  zero.leadDays.value = "0";
  assert.equal(buildReminderPayload(zero).remind_lead_days, 0);
});

test("evening time must be a valid clock", () => {
  const elements = makeElements();
  elements.eveningTime.value = "25:00";
  assert.throws(() => buildReminderPayload(elements), /HH:mm/);
});
