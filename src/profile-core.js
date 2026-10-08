import { dateKeysBetween, validBusinessDate } from "./task-transfer-core.js";

export function profileRange(today, days = 365) {
  if (!validBusinessDate(today) || !Number.isInteger(days) || days < 1) throw new TypeError("统计范围无效");
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: today };
}

export function aggregateCompletionHistory(rows) {
  const byDate = new Map();
  for (const row of rows || []) {
    if (row?.is_active === false) continue;
    const date = String(row?.completion_date || "").slice(0, 10);
    if (!validBusinessDate(date)) continue;
    const key = `${row.task_id}\u0000${date}`;
    const bucket = byDate.get(date) || { count: 0, items: [], keys: new Set() };
    if (!bucket.keys.has(key)) {
      bucket.keys.add(key);
      bucket.count += 1;
      bucket.items.push({ taskId: String(row.task_id), title: String(row.task_title_snapshot || "已删除任务") });
    }
    byDate.set(date, bucket);
  }
  return byDate;
}

export function currentCompletionStreak(byDate, today) {
  const todayCount = byDate.get(today)?.count || 0;
  const cursor = new Date(`${today}T00:00:00Z`);
  if (!todayCount) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (byDate.get(cursor.toISOString().slice(0, 10))?.count) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export function buildHeatmap(rows, today, days = 365) {
  const range = profileRange(today, days);
  const byDate = aggregateCompletionHistory(rows);
  const dates = dateKeysBetween(range.start, range.end, days);
  const firstWeekday = new Date(`${range.start}T00:00:00Z`).getUTCDay();
  const leading = (firstWeekday + 6) % 7;
  const cells = dates.map(date => ({ date, count: byDate.get(date)?.count || 0 }));
  const total = cells.reduce((sum, cell) => sum + cell.count, 0);
  const max = Math.max(0, ...cells.map(cell => cell.count));
  return { range, byDate, leading, cells, total, max, streak: currentCompletionStreak(byDate, today) };
}

export function heatLevel(count, max) {
  if (!count || !max) return 0;
  if (count >= max) return 4;
  return Math.max(1, Math.ceil(count / max * 4));
}
