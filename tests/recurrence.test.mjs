import test from "node:test";
import assert from "node:assert/strict";
import {
  completionKey,
  isoWeekday,
  recurrenceAppearsOn,
  taskAppearsOn,
} from "../src/recurrence-core.js";

test("uses ISO weekdays without depending on the machine timezone", () => {
  assert.equal(isoWeekday("2026-10-05"), 1);
  assert.equal(isoWeekday("2026-10-11"), 7);
});

test("weekly recurrence respects selected weekdays and date window", () => {
  const rule = { frequency: "weekly", weekdays: [1, 3, 5], start_date: "2026-10-05", end_date: "2026-10-16" };
  assert.equal(recurrenceAppearsOn(rule, "2026-10-05"), true);
  assert.equal(recurrenceAppearsOn(rule, "2026-10-06"), false);
  assert.equal(recurrenceAppearsOn(rule, "2026-10-16"), true);
  assert.equal(recurrenceAppearsOn(rule, "2026-10-19"), false);
});

test("monthly recurrence skips months that do not contain the requested day", () => {
  const rule = { frequency: "monthly", month_day: 31, start_date: "2026-01-01", end_date: null };
  assert.equal(recurrenceAppearsOn(rule, "2026-01-31"), true);
  assert.equal(recurrenceAppearsOn(rule, "2026-02-28"), false);
  assert.equal(recurrenceAppearsOn(rule, "2026-03-31"), true);
});

test("deleted tasks never appear and recurring occurrences have per-day completion keys", () => {
  const task = { id: "habit", type: "recurring", deleted_at: null };
  const rules = new Map([["habit", { frequency: "weekly", weekdays: [4], start_date: "2026-10-01" }]]);
  assert.equal(taskAppearsOn(task, "2026-10-08", rules), true);
  assert.equal(completionKey(task, "2026-10-08"), "habit:2026-10-08");
  assert.equal(taskAppearsOn({ ...task, deleted_at: "2026-10-08T10:00:00Z" }, "2026-10-08", rules), false);
});
