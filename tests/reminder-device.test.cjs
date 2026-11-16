const { test } = require("node:test");
const assert = require("node:assert/strict");

const { handleRequest, extractToken, sha256 } = require("../cloudfunctions/reminder-device");

function mockRpc(responses = {}) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (Object.prototype.hasOwnProperty.call(responses, name)) {
      return responses[name];
    }
    return { ok: true };
  };
  return { rpc, calls };
}

test("extractToken supports X-Device-Token and Bearer formats", () => {
  const hex64 = "a".repeat(64);
  assert.equal(extractToken({ "x-device-token": hex64 }), hex64);
  assert.equal(extractToken({ "X-Device-Token": hex64.toUpperCase() }), hex64);
  assert.equal(extractToken({ authorization: `Bearer ${hex64}` }), hex64);
  assert.equal(extractToken({ authorization: "Bearer invalid" }), null);
  assert.equal(extractToken({}), null);
});

test("pair endpoint validates 6-digit code and tokenHash", async () => {
  const { rpc, calls } = mockRpc({ reminder_device_pair: { ok: true, device_id: "dev_123" } });

  // Invalid params
  const bad = await handleRequest({
    httpMethod: "POST",
    path: "/api/reminder/device/pair",
    body: JSON.stringify({ code: "123", name: "PC", tokenHash: "bad" })
  }, { rpc });
  assert.equal(bad.statusCode, 400);
  assert.equal(calls.length, 0);

  // Success
  const hex64 = "f".repeat(64);
  const good = await handleRequest({
    httpMethod: "POST",
    path: "/api/reminder/device/pair",
    body: JSON.stringify({ code: "123456", name: "My Workstation", tokenHash: hex64 })
  }, { rpc });
  assert.equal(good.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "reminder_device_pair");
  assert.equal(calls[0].args.p_code, "123456");
  assert.equal(calls[0].args.p_name, "My Workstation");
  assert.equal(calls[0].args.p_token_hash, hex64);
});

test("feed endpoint requires token and calls RPC", async () => {
  const hex64 = "b".repeat(64);
  const expectedHash = sha256(hex64);
  const { rpc, calls } = mockRpc({ reminder_device_feed: { ok: true, items: [] } });

  // Missing token
  const unauth = await handleRequest({
    httpMethod: "POST",
    path: "/api/reminder/device/feed",
    body: "{}"
  }, { rpc });
  assert.equal(unauth.statusCode, 401);

  // Valid token
  const res = await handleRequest({
    httpMethod: "POST",
    path: "/api/reminder/device/feed",
    headers: { "x-device-token": hex64 },
    body: JSON.stringify({ now: "2026-11-05T12:00:00Z" })
  }, { rpc });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "reminder_device_feed");
  assert.equal(calls[0].args.p_token_hash, expectedHash);
  assert.equal(calls[0].args.p_now, "2026-11-05T12:00:00Z");
});

test("ack and complete endpoints pass task and date params", async () => {
  const hex64 = "c".repeat(64);
  const expectedHash = sha256(hex64);
  const { rpc, calls } = mockRpc({
    reminder_device_ack: true,
    reminder_device_complete: { ok: true, title: "测试任务" }
  });

  // ACK
  const ackRes = await handleRequest({
    httpMethod: "POST",
    path: "/api/reminder/device/ack",
    headers: { "X-Device-Token": hex64 },
    body: JSON.stringify({ taskId: "t-1", remindDate: "2026-11-05", status: "sent" })
  }, { rpc });
  assert.equal(ackRes.statusCode, 200);
  assert.equal(calls[0].name, "reminder_device_ack");
  assert.equal(calls[0].args.p_token_hash, expectedHash);
  assert.equal(calls[0].args.p_task_id, "t-1");
  assert.equal(calls[0].args.p_remind_date, "2026-11-05");

  // Complete
  const compRes = await handleRequest({
    httpMethod: "POST",
    path: "/api/reminder/device/complete",
    headers: { "Authorization": `Bearer ${hex64}` },
    body: JSON.stringify({ taskId: "t-1", remindDate: "2026-11-05" })
  }, { rpc });
  assert.equal(compRes.statusCode, 200);
  assert.equal(calls[1].name, "reminder_device_complete");
  assert.equal(calls[1].args.p_task_id, "t-1");
});
