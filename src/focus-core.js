const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function asTime(value) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError("无效的时间值");
  return time;
}

function iso(time) {
  return new Date(time).toISOString();
}

function copy(session) {
  return { ...session, segments: session.segments.map(segment => ({ ...segment })) };
}

export function shanghaiDateKey(value = Date.now()) {
  return new Date(asTime(value) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function sessionElapsedSeconds(session, now = Date.now()) {
  const confirmed = Math.max(0, Number(session.elapsed_seconds) || 0);
  if (session.status !== "running" || !session.running_since) {
    return Math.min(confirmed, session.planned_seconds);
  }
  const running = Math.max(0, (asTime(now) - asTime(session.running_since)) / 1000);
  return Math.min(session.planned_seconds, confirmed + running);
}

export function remainingSeconds(session, now = Date.now()) {
  return Math.max(0, Math.ceil(session.planned_seconds - sessionElapsedSeconds(session, now)));
}

export function createFocusSession({ id, ownerId, phase = "focus", plannedSeconds, task = null, now = Date.now() }) {
  const startedAt = asTime(now);
  if (!id || !ownerId) throw new TypeError("会话必须包含 ID 与用户 ID");
  if (!Number.isInteger(plannedSeconds) || plannedSeconds < 1) throw new RangeError("计划时长必须是正整数秒");
  if (!['focus', 'break'].includes(phase)) throw new RangeError("未知计时阶段");
  return {
    id,
    owner_id: ownerId,
    phase,
    status: "running",
    task_id: task?.id || null,
    task_title_snapshot: task?.title || null,
    planned_seconds: plannedSeconds,
    elapsed_seconds: 0,
    started_at: iso(startedAt),
    running_since: iso(startedAt),
    deadline_at: iso(startedAt + plannedSeconds * 1000),
    ended_at: null,
    updated_at: iso(startedAt),
    segments: [{ started_at: iso(startedAt), ended_at: null }]
  };
}

function closeRunningSegment(session, endTime) {
  const last = session.segments.at(-1);
  if (last && !last.ended_at) last.ended_at = iso(endTime);
}

export function pauseFocusSession(input, now = Date.now()) {
  if (input.status !== "running") return copy(input);
  const session = copy(input);
  const current = Math.min(asTime(now), asTime(session.deadline_at));
  session.elapsed_seconds = Math.round(sessionElapsedSeconds(session, current));
  closeRunningSegment(session, current);
  session.status = session.elapsed_seconds >= session.planned_seconds ? "completed" : "paused";
  session.running_since = null;
  session.deadline_at = null;
  session.updated_at = iso(current);
  if (session.status === "completed") session.ended_at = iso(current);
  return session;
}

export function resumeFocusSession(input, now = Date.now()) {
  if (input.status !== "paused") return copy(input);
  const session = copy(input);
  const current = asTime(now);
  const remaining = Math.max(0, session.planned_seconds - session.elapsed_seconds);
  if (!remaining) return finishFocusSession(session, current, true);
  session.status = "running";
  session.running_since = iso(current);
  session.deadline_at = iso(current + remaining * 1000);
  session.updated_at = iso(current);
  session.segments.push({ started_at: iso(current), ended_at: null });
  return session;
}

export function finishFocusSession(input, now = Date.now(), completed = false) {
  if (["completed", "ended"].includes(input.status)) return copy(input);
  const session = copy(input);
  const current = session.status === "running"
    ? Math.min(asTime(now), asTime(session.deadline_at))
    : asTime(now);
  session.elapsed_seconds = Math.round(sessionElapsedSeconds(session, current));
  closeRunningSegment(session, current);
  const reachedTarget = session.elapsed_seconds >= session.planned_seconds;
  session.status = completed || reachedTarget ? "completed" : "ended";
  session.running_since = null;
  session.deadline_at = null;
  session.ended_at = iso(current);
  session.updated_at = iso(current);
  return session;
}

export function settleExpiredSession(session, now = Date.now()) {
  if (session.status === "running" && asTime(now) >= asTime(session.deadline_at)) {
    return finishFocusSession(session, asTime(session.deadline_at), true);
  }
  return copy(session);
}

export function splitSegmentByShanghaiDate(segment) {
  let cursor = asTime(segment.started_at);
  const end = asTime(segment.ended_at);
  if (end <= cursor) return [];
  const pieces = [];
  while (cursor < end) {
    const shifted = new Date(cursor + SHANGHAI_OFFSET_MS);
    const nextUtcMidnight = Date.UTC(
      shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1
    ) - SHANGHAI_OFFSET_MS;
    const pieceEnd = Math.min(end, nextUtcMidnight);
    pieces.push({ date: shanghaiDateKey(cursor), seconds: (pieceEnd - cursor) / 1000 });
    cursor = pieceEnd;
  }
  return pieces;
}

export function sessionSegmentsAt(session, now = Date.now()) {
  const segments = session.segments.map(segment => ({ ...segment }));
  const last = segments.at(-1);
  if (last && !last.ended_at && session.status === "running") {
    last.ended_at = iso(Math.min(asTime(now), asTime(session.deadline_at)));
  }
  return segments.filter(segment => segment.ended_at);
}

export function focusSecondsByDate(sessions, now = Date.now()) {
  const totals = new Map();
  for (const session of sessions) {
    if (session.phase !== "focus") continue;
    for (const segment of sessionSegmentsAt(session, now)) {
      for (const piece of splitSegmentByShanghaiDate(segment)) {
        totals.set(piece.date, (totals.get(piece.date) || 0) + piece.seconds);
      }
    }
  }
  return totals;
}

export function sevenDayFocusStats(sessions, endDate = shanghaiDateKey(), now = Date.now()) {
  const totals = focusSecondsByDate(sessions, now);
  const end = new Date(`${endDate}T00:00:00+08:00`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - (6 - index));
    const key = shanghaiDateKey(date);
    const completedRounds = sessions.filter(session => session.phase === "focus"
      && session.status === "completed" && session.ended_at && shanghaiDateKey(session.ended_at) === key).length;
    return { date: key, seconds: Math.round(totals.get(key) || 0), completedRounds };
  });
}

export function taskFocusSeconds(sessions, taskId, date, now = Date.now()) {
  let total = 0;
  for (const session of sessions) {
    if (session.phase !== "focus" || session.task_id !== taskId) continue;
    for (const segment of sessionSegmentsAt(session, now)) {
      total += splitSegmentByShanghaiDate(segment)
        .filter(piece => piece.date === date)
        .reduce((sum, piece) => sum + piece.seconds, 0);
    }
  }
  return Math.round(total);
}

export function formatFocusDuration(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  if (safe === 0) return "0 分钟";
  if (safe < 60) return `不到 1 分钟（${safe} 秒）`;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}
