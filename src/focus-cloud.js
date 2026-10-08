const SESSION_COLUMNS = [
  "id", "phase", "status", "planned_seconds", "elapsed_seconds", "task_id",
  "task_title_snapshot", "started_at", "running_since", "deadline_at", "ended_at",
  "segments", "revision", "created_at", "updated_at",
];

function rowFor(session, revision) {
  return Object.fromEntries(SESSION_COLUMNS.map((key) => [key,
    key === "revision" ? revision : session[key] ?? null
  ]));
}

function normalizeRow(row, ownerId) {
  return {
    ...row,
    owner_id: ownerId,
    planned_seconds: Number(row.planned_seconds),
    elapsed_seconds: Number(row.elapsed_seconds) || 0,
    revision: Number(row.revision) || 1,
    segments: Array.isArray(row.segments) ? row.segments : [],
  };
}

export function createFocusCloudStore({ db, cloudResult, getUid }) {
  async function load() {
    if (!getUid()) return [];
    const [recent, active] = await Promise.all([
      cloudResult(db.from("todo_focus_sessions").select("*").order("started_at", { ascending: false }).range(0, 199)),
      cloudResult(db.from("todo_focus_sessions").select("*").in("status", ["running", "paused"])),
    ]);
    const rows = new Map([...active, ...recent].map((row) => [row.id, row]));
    return [...rows.values()].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
      .map((row) => normalizeRow(row, getUid()));
  }

  async function persist(session, previous = null) {
    if (!previous) {
      const next = { ...session, revision: 1, created_at: session.created_at || session.started_at };
      await cloudResult(db.from("todo_focus_sessions").insert(rowFor(next, 1)));
      return next;
    }
    const expected = Number(previous.revision) || 1;
    const next = { ...session, revision: expected + 1 };
    await cloudResult(db.from("todo_focus_sessions").update(rowFor(next, next.revision))
      .eq("id", session.id).eq("revision", expected));
    const rows = await cloudResult(db.from("todo_focus_sessions").select("*").eq("id", session.id));
    const saved = Array.isArray(rows) ? rows[0] : null;
    if (!saved || Number(saved.revision) !== next.revision) {
      const error = new Error("这轮专注已在另一个页面更新，请刷新后继续。");
      error.code = "FOCUS_REVISION_CONFLICT";
      throw error;
    }
    return normalizeRow(saved, getUid());
  }

  async function migrateLocal(sessions) {
    let migrated = 0;
    for (const session of sessions) {
      if (!session?.id || session.owner_id !== getUid()) continue;
      const existing = await cloudResult(db.from("todo_focus_sessions").select("id").eq("id", session.id));
      if (Array.isArray(existing) && existing.length) continue;
      try {
        await persist({ ...session, status: session.status === "cancelled" ? "ended" : session.status });
        migrated += 1;
      } catch (error) {
        if (!/duplicate|unique/i.test(String(error?.message || ""))) throw error;
      }
    }
    return migrated;
  }

  return { load, persist, migrateLocal };
}
