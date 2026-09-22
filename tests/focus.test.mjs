import test from "node:test";
import assert from "node:assert/strict";
import {
  createFocusSession,
  finishFocusSession,
  formatFocusDuration,
  pauseFocusSession,
  resumeFocusSession,
  sevenDayFocusStats,
  splitSegmentByShanghaiDate,
  taskFocusSeconds
} from "../src/focus-core.js";
import { formatLunarDate, formatSolarDate, shanghaiTodayKey } from "../src/date-display.js";

const at = value => Date.parse(value);

test("pause time is excluded and an early end does not count as a completed round", () => {
  let session = createFocusSession({ id: "one", ownerId: "user", plannedSeconds: 25 * 60, now: at("2026-09-22T01:00:00Z") });
  session = pauseFocusSession(session, at("2026-09-22T01:10:00Z"));
  assert.equal(session.elapsed_seconds, 600);
  session = resumeFocusSession(session, at("2026-09-22T01:15:00Z"));
  session = finishFocusSession(session, at("2026-09-22T01:23:00Z"));
  assert.equal(session.elapsed_seconds, 1080);
  assert.equal(session.status, "ended");
  const today = sevenDayFocusStats([session], "2026-09-22", at("2026-09-22T02:00:00Z")).at(-1);
  assert.equal(today.seconds, 1080);
  assert.equal(today.completedRounds, 0);
});

test("a focus interval crossing Shanghai midnight is split by actual occupancy", () => {
  const segment = { started_at: "2026-09-22T15:50:00.000Z", ended_at: "2026-09-22T16:15:00.000Z" };
  assert.deepEqual(splitSegmentByShanghaiDate(segment), [
    { date: "2026-09-22", seconds: 600 },
    { date: "2026-09-23", seconds: 900 }
  ]);
});

test("task totals use the viewed Shanghai date and retain title snapshots", () => {
  let session = createFocusSession({
    id: "linked", ownerId: "user", plannedSeconds: 1500,
    task: { id: "task-1", title: "学习" }, now: at("2026-09-22T15:50:00Z")
  });
  session = finishFocusSession(session, at("2026-09-22T16:15:00Z"), true);
  assert.equal(taskFocusSeconds([session], "task-1", "2026-09-22"), 600);
  assert.equal(taskFocusSeconds([session], "task-1", "2026-09-23"), 900);
  assert.equal(session.task_title_snapshot, "学习");
});

test("sub-minute durations are not rounded up to a minute", () => {
  assert.equal(formatFocusDuration(42), "不到 1 分钟（42 秒）");
  assert.equal(formatFocusDuration(60), "1 分钟");
});

test("Shanghai date keys and the verified lunar date do not depend on the machine timezone", () => {
  assert.equal(shanghaiTodayKey(at("2026-09-21T16:30:00Z")), "2026-09-22");
  assert.match(formatSolarDate("2028-02-29"), /2028年2月29日.*星期二/);
  assert.equal(formatLunarDate("2026-09-22"), "农历八月十二");
});
