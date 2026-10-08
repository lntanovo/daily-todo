import test from "node:test";
import assert from "node:assert/strict";
import { exportTaskRecords, markPossibleDuplicates, parseNumberedTasks, recordsToMarkdown } from "../src/task-transfer-core.js";

test("numbered Chinese and Markdown tasks parse without keeping numbering", () => {
  const parsed = parseNumberedTasks("1、完成数学作业\n2. [ ] 阅读第二章\n3) 整理课堂笔记", "2026-09-27");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.items.map(item => item.title), ["完成数学作业", "阅读第二章", "整理课堂笔记"]);
});

test("missing numbers and unnumbered paragraphs are located", () => {
  const parsed = parseNumberedTasks("1、第一项\n3、第三项\n这不是元数据", "2026-09-27");
  assert.deepEqual(parsed.errors.map(error => error.line), [2, 3]);
});

test("export metadata round-trips while completed state stays informational", () => {
  const task = { id: "a", title: "复习", type: "range", startDate: "2026-09-27", endDate: "2026-09-28", startTime: "19:00", endTime: "20:00", priority: "urgent", createdAt: "2026-09-27T00:00:00Z" };
  const records = exportTaskRecords([task], { "a:2026-09-27": true }, { mode: "all" });
  const markdown = recordsToMarkdown(records, "全部任务");
  const parsed = parseNumberedTasks(markdown, "2026-09-27");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.items[0].type, "range");
  assert.equal(parsed.items[0].priority, "urgent");
  assert.equal(parsed.items[0].startTime, "19:00");
  assert.equal(parsed.items[0].completionIgnored, true);
});

test("duplicates default to skipped", () => {
  const parsed = parseNumberedTasks("1、重复任务\n2、重复任务", "2026-09-27");
  const marked = markPossibleDuplicates(parsed.items, [{ title: "重复任务", type: "single", date: "2026-09-27" }]);
  assert.ok(marked.every(item => item.duplicate && !item.selected));
});
