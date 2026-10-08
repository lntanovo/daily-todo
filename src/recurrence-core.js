const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseBusinessDate(value) {
  if (!DATE_RE.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date;
}

export function isoWeekday(value) {
  const date = parseBusinessDate(value);
  if (!date) return null;
  const weekday = date.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function normalizeRecurrence(input = {}) {
  const frequency = input.frequency === "monthly" ? "monthly" : "weekly";
  const weekdays = frequency === "weekly"
    ? [...new Set((input.weekdays || []).map(Number).filter((day) => day >= 1 && day <= 7))].sort()
    : null;
  const monthDay = frequency === "monthly" ? Number(input.month_day ?? input.monthDay) : null;
  return {
    ...input,
    frequency,
    weekdays,
    month_day: Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31 ? monthDay : null,
  };
}

export function recurrenceAppearsOn(rule, dateText) {
  const date = parseBusinessDate(dateText);
  if (!date || !rule) return false;
  const normalized = normalizeRecurrence(rule);
  if (!parseBusinessDate(normalized.start_date)) return false;
  if (dateText < normalized.start_date) return false;
  if (normalized.end_date && dateText > normalized.end_date) return false;
  if (normalized.frequency === "weekly") {
    return normalized.weekdays?.includes(isoWeekday(dateText)) || false;
  }
  return normalized.month_day === date.getUTCDate();
}

export function taskAppearsOn(task, dateText, recurrenceByTaskId = new Map()) {
  if (!task || task.deleted_at) return false;
  if (task.type === "single") return (task.task_date ?? task.date) === dateText;
  if (task.type === "range") return dateText >= (task.start_date ?? task.startDate) && dateText <= (task.end_date ?? task.endDate);
  if (task.type === "recurring") {
    const rule = recurrenceByTaskId instanceof Map
      ? recurrenceByTaskId.get(task.id)
      : recurrenceByTaskId[task.id];
    return recurrenceAppearsOn(rule, dateText);
  }
  return false;
}

export function completionKey(task, dateText) {
  return task?.type === "single" ? task.id : `${task?.id}:${dateText}`;
}
