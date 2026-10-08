import test from "node:test";
import assert from "node:assert/strict";
import { buildHeatmap, currentCompletionStreak, aggregateCompletionHistory } from "../src/profile-core.js";

test("today may be empty while yesterday keeps the current streak", () => {
  const rows = [
    { task_id: "a", completion_date: "2026-09-26", task_title_snapshot: "A", is_active: true },
    { task_id: "b", completion_date: "2026-09-25", task_title_snapshot: "B", is_active: true },
    { task_id: "c", completion_date: "2026-09-24", task_title_snapshot: "C", is_active: true }
  ];
  assert.equal(currentCompletionStreak(aggregateCompletionHistory(rows), "2026-09-27"), 3);
});

test("inactive rows and duplicate task/date pairs are excluded", () => {
  const rows = [
    { task_id: "a", completion_date: "2026-09-27", task_title_snapshot: "A", is_active: true },
    { task_id: "a", completion_date: "2026-09-27", task_title_snapshot: "A", is_active: true },
    { task_id: "b", completion_date: "2026-09-27", task_title_snapshot: "B", is_active: false }
  ];
  const result = buildHeatmap(rows, "2026-09-27", 365);
  assert.equal(result.total, 1);
  assert.equal(result.streak, 1);
  assert.equal(result.cells.length, 365);
});

test("the current streak can extend beyond the 365-day heatmap", () => {
  const today = new Date("2026-09-27T00:00:00Z");
  const rows = Array.from({ length: 400 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - index);
    return { task_id: `task-${index}`, completion_date: date.toISOString().slice(0, 10), task_title_snapshot: "持续完成", is_active: true };
  });
  const result = buildHeatmap(rows, "2026-09-27", 365);
  assert.equal(result.cells.length, 365);
  assert.equal(result.total, 365);
  assert.equal(result.streak, 400);
});
