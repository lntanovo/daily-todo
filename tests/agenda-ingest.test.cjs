const { test } = require("node:test");
const assert = require("node:assert/strict");

const ingest = require("../cloudfunctions/agenda-ingest/index.js");

const OWNER = "lnreg_test_owner";

test("a complete sentence becomes one single-day task", () => {
  const result = ingest.normalize(
    { title: "交操作系统作业3", date: "2026-11-19", time: "23:59", kind: "deadline" },
    OWNER
  );
  assert.equal(result.ok, true);
  assert.equal(result.row.type, "single");
  assert.equal(result.row.task_date, "2026-11-19");
  assert.equal(result.row.remind_time, "23:59");
  assert.equal(result.row.remind_enabled, true);
  assert.equal(result.row.owner_id, OWNER);
  assert.match(result.row.id, /^[0-9a-f-]{36}$/);
});

test("a date without a clock falls back to the evening reminder", () => {
  const result = ingest.normalize({ title: "交实验报告", date: "2026-11-20" }, OWNER);
  assert.equal(result.ok, true);
  assert.equal(result.row.remind_time, "20:00");
  assert.equal(result.kind, "task");
});

test("titles are trimmed and inner whitespace collapsed", () => {
  const result = ingest.normalize({ title: "  交   作业  ", date: "2026-11-20" }, OWNER);
  assert.equal(result.row.title, "交 作业");
});

test("bad dates, clocks, kinds and titles are rejected", () => {
  const cases = [
    [{ title: "", date: "2026-11-20" }, "INVALID_TITLE"],
    [{ title: "x".repeat(161), date: "2026-11-20" }, "INVALID_TITLE"],
    [{ title: "作业", date: "2026-02-30" }, "INVALID_DATE"],
    [{ title: "作业", date: "2026-11-20", time: "24:00" }, "INVALID_TIME"],
    [{ title: "作业", date: "2026-11-20", kind: "meeting" }, "INVALID_KIND"],
    [null, "INVALID_BODY"]
  ];
  for (const [payload, code] of cases) {
    const result = ingest.normalize(payload, OWNER);
    assert.equal(result.ok, false, `${JSON.stringify(payload)} should fail`);
    assert.equal(result.code, code);
  }
});

test("the shared secret is compared without leaking length", () => {
  process.env.BOT_SHARED_SECRET = "s3cret-value";
  assert.equal(ingest.sameSecret("s3cret-value"), true);
  assert.equal(ingest.sameSecret("s3cret-valuE"), false);
  assert.equal(ingest.sameSecret("short"), false);
  assert.equal(ingest.sameSecret(""), false);
  delete process.env.BOT_SHARED_SECRET;
  assert.equal(ingest.sameSecret("s3cret-value"), false, "an unset secret must never authorize");
});

test("headers are read case-insensitively", () => {
  assert.equal(ingest.headerOf({ "X-Bot-Secret": "abc" }, "x-bot-secret"), "abc");
  assert.equal(ingest.headerOf({ "x-bot-secret": ["abc"] }, "X-Bot-Secret"), "abc");
  assert.equal(ingest.headerOf({}, "x-bot-secret"), "");
  assert.equal(ingest.headerOf(null, "x-bot-secret"), "");
});

test("only POST is accepted, and only with a valid secret", async () => {
  process.env.BOT_SHARED_SECRET = "s3cret-value";
  const rest = async () => [];
  const get = await ingest.handleRequest({ httpMethod: "GET" }, { rest, ownerId: OWNER });
  assert.equal(get.statusCode, 405);

  const unauthorized = await ingest.handleRequest(
    { httpMethod: "POST", headers: {}, body: "{}" },
    { rest, ownerId: OWNER }
  );
  assert.equal(unauthorized.statusCode, 401);

  const badJson = await ingest.handleRequest(
    { httpMethod: "POST", headers: { "x-bot-secret": "s3cret-value" }, body: "{" },
    { rest, ownerId: OWNER }
  );
  assert.equal(badJson.statusCode, 400);
  delete process.env.BOT_SHARED_SECRET;
});

test("an existing task on the same date is reported as a duplicate", async () => {
  process.env.BOT_SHARED_SECRET = "s3cret-value";
  const calls = [];
  const rest = async (path, init) => {
    calls.push({ path, method: init && init.method });
    if (!init || !init.method) return [{ id: "existing-id" }];
    throw new Error("insert must not run for a duplicate");
  };
  const response = await ingest.handleRequest(
    {
      httpMethod: "POST",
      headers: { "x-bot-secret": "s3cret-value" },
      body: JSON.stringify({ title: "交作业", date: "2026-11-19" })
    },
    { rest, ownerId: OWNER }
  );
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.duplicate, true);
  assert.equal(body.id, "existing-id");
  assert.equal(calls.length, 1);
  delete process.env.BOT_SHARED_SECRET;
});

test("a fresh task is inserted once", async () => {
  process.env.BOT_SHARED_SECRET = "s3cret-value";
  const writes = [];
  const rest = async (path, init) => {
    if (!init || !init.method) return [];
    writes.push(JSON.parse(init.body));
    return [{ id: "new" }];
  };
  const response = await ingest.handleRequest(
    {
      httpMethod: "POST",
      headers: { "x-bot-secret": "s3cret-value" },
      body: JSON.stringify({ title: "讲座", date: "2026-11-18", time: "15:00", kind: "event" })
    },
    { rest, ownerId: OWNER, siteUrl: "https://todo.example" }
  );
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.duplicate, false);
  assert.equal(body.site, "https://todo.example");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].task_date, "2026-11-18");
  assert.equal(writes[0].remind_time, "15:00");
  delete process.env.BOT_SHARED_SECRET;
});
