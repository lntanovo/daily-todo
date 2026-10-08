import test from "node:test";
import assert from "node:assert/strict";
import { createFocusCloudStore } from "../src/focus-cloud.js";

function fakeDb() {
  const rows = [];
  const from = () => {
    const filters = [];
    let action = "select";
    let values;
    const query = {
      select() { action = "select"; return query; }, order() { return query; }, range() { return query; }, in() { return query; },
      insert(next) { action = "insert"; values = next; return query; },
      update(next) { action = "update"; values = next; return query; },
      eq(key, value) { filters.push((row) => row[key] === value); return query; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (action === "insert") rows.push(structuredClone(values));
          if (action === "update") rows.filter((row) => filters.every((filter) => filter(row))).forEach((row) => Object.assign(row, structuredClone(values)));
          return { data: action === "select" ? structuredClone(rows.filter((row) => filters.every((filter) => filter(row)))) : null, error: null };
        }).then(resolve, reject);
      },
    };
    return query;
  };
  return { db: { from }, rows };
}

test("focus cloud store creates and revision-checks updates", async () => {
  const { db, rows } = fakeDb();
  const store = createFocusCloudStore({ db, cloudResult: async (request) => (await request).data, getUid: () => "u1" });
  const base = { id: "s1", owner_id: "u1", phase: "focus", status: "running", planned_seconds: 60, elapsed_seconds: 0, started_at: "2026-10-08T00:00:00Z", running_since: "2026-10-08T00:00:00Z", deadline_at: "2026-10-08T00:01:00Z", segments: [] };
  const created = await store.persist(base);
  assert.equal(created.revision, 1);
  const updated = await store.persist({ ...created, status: "paused", elapsed_seconds: 10 }, created);
  assert.equal(updated.revision, 2);
  assert.equal(rows[0].status, "paused");
});

test("focus cloud store detects stale revisions", async () => {
  const { db, rows } = fakeDb();
  const store = createFocusCloudStore({ db, cloudResult: async (request) => (await request).data, getUid: () => "u1" });
  const created = await store.persist({ id: "s1", phase: "focus", status: "running", planned_seconds: 60, elapsed_seconds: 0, started_at: "2026-10-08T00:00:00Z", segments: [] });
  rows[0].revision = 3;
  await assert.rejects(() => store.persist({ ...created, status: "paused" }, created), /另一个页面/);
});
