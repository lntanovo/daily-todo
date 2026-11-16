"""SQLite persistence for the agenda plugin.

Pure standard library so it can be unit tested without AstrBot installed.
Timestamps are stored as integer UNIX seconds; the display timezone is a fixed
UTC+8 offset because mainland China has no DST (``zoneinfo`` also needs the
``tzdata`` package on Windows, which we do not want to depend on).
"""

from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

CST = timezone(timedelta(hours=8))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    message_id  TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL,
    sender_id   TEXT NOT NULL,
    sender_name TEXT NOT NULL DEFAULT '',
    ts          INTEGER NOT NULL,
    text        TEXT NOT NULL,
    batch_id    INTEGER,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(batch_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages(group_id, ts);

CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    title_norm    TEXT NOT NULL,
    start_at      INTEGER,
    end_at        INTEGER,
    all_day       INTEGER NOT NULL DEFAULT 0,
    location      TEXT,
    participants  TEXT,
    group_id      TEXT,
    source_msg_ids TEXT NOT NULL DEFAULT '[]',
    raw_excerpt   TEXT,
    confidence    REAL NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'confirmed',
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);

CREATE TABLE IF NOT EXISTS reminders (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    fire_at  INTEGER NOT NULL,
    kind     TEXT NOT NULL,
    sent_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(sent_at, fire_at);

CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 私聊里"先解析、等用户确认"的草稿。确认前绝不写云端，避免模型认错污染日程。
CREATE TABLE IF NOT EXISTS pending (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_key   TEXT NOT NULL,
    raw_text   TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_chat ON pending(chat_key, created_at DESC);

-- 开机补拉：关机期间收到的私聊，解析后排队逐条确认（确认前不写云端）。
CREATE TABLE IF NOT EXISTS catchup (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_key   TEXT NOT NULL,
    message_id TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    raw_text   TEXT NOT NULL,
    payload    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued',
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catchup_msg ON catchup(message_id);
CREATE INDEX IF NOT EXISTS idx_catchup_state ON catchup(chat_key, status, ts);

-- 到点追问"完成了吗"：一个 (任务, 日期) 只问一次，答案也记在这里。
CREATE TABLE IF NOT EXISTS followups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    day         TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    clock       TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'asked',
    asked_at    INTEGER NOT NULL,
    answered_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_followups_task_day ON followups(task_id, day);
CREATE INDEX IF NOT EXISTS idx_followups_open ON followups(status, asked_at);
"""


def now_ts() -> int:
    """Current UNIX timestamp in seconds."""
    return int(time.time())


def to_local(ts: int | None) -> datetime | None:
    """Convert a stored timestamp to a UTC+8 datetime."""
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, CST)


def format_ts(ts: int | None, *, with_year: bool = False) -> str:
    """Render a stored timestamp for chat output."""
    dt = to_local(ts)
    if dt is None:
        return "未定"
    return dt.strftime("%Y-%m-%d %H:%M") if with_year else dt.strftime("%m-%d %H:%M")


class Store:
    """Thread-safe wrapper around one SQLite connection."""

    def __init__(self, db_path: str | Path, hourly_cap: int = 300) -> None:
        path = Path(db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.hourly_cap = max(1, int(hourly_cap))
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    # ------------------------------------------------------------------ 消息

    def add_message(
        self,
        *,
        message_id: str,
        group_id: str,
        sender_id: str,
        sender_name: str,
        ts: int,
        text: str,
    ) -> bool:
        """Insert one raw message.

        Returns:
            True when the row was new, False when it was a duplicate or the
            per-group hourly cap was already reached.
        """
        with self._lock:
            if self.hourly_count(group_id, ts - 3600) >= self.hourly_cap:
                return False
            cur = self._conn.execute(
                "INSERT OR IGNORE INTO messages"
                " (message_id, group_id, sender_id, sender_name, ts, text,"
                "  batch_id, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
                (message_id, group_id, sender_id, sender_name, ts, text, now_ts()),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def hourly_count(self, group_id: str, since_ts: int) -> int:
        """Count messages already stored for a group since ``since_ts``."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND ts >= ?",
                (group_id, since_ts),
            ).fetchone()
        return int(row["n"])

    # ------------------------------------------------------------------ 草稿

    def add_pending(self, chat_key: str, raw_text: str, payload: str) -> int:
        """Remember one parsed draft until the owner confirms or drops it."""
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO pending (chat_key, raw_text, payload, created_at)"
                " VALUES (?, ?, ?, ?)",
                (chat_key, raw_text, payload, now_ts()),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def latest_pending(self, chat_key: str) -> dict | None:
        """Return the newest draft for a chat, or None."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM pending WHERE chat_key = ?"
                " ORDER BY created_at DESC, id DESC LIMIT 1",
                (chat_key,),
            ).fetchone()
        return dict(row) if row is not None else None

    def drop_pending(self, pending_id: int) -> None:
        """Delete one draft by id."""
        with self._lock:
            self._conn.execute("DELETE FROM pending WHERE id = ?", (pending_id,))
            self._conn.commit()

    def clear_pending(self, chat_key: str) -> None:
        """Delete every draft for a chat."""
        with self._lock:
            self._conn.execute("DELETE FROM pending WHERE chat_key = ?", (chat_key,))
            self._conn.commit()

    # ------------------------------------------------------------------ 补拉

    def enqueue_catchup(
        self,
        *,
        chat_key: str,
        message_id: str,
        ts: int,
        raw_text: str,
        payload: str,
    ) -> bool:
        """Queue one missed message for confirmation.

        Returns:
            True when the row was new, False when the id was already queued.
        """
        with self._lock:
            cur = self._conn.execute(
                "INSERT OR IGNORE INTO catchup"
                " (chat_key, message_id, ts, raw_text, payload, status, created_at)"
                " VALUES (?, ?, ?, ?, ?, 'queued', ?)",
                (chat_key, message_id, int(ts), raw_text, payload, now_ts()),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def next_catchup(self, chat_key: str) -> sqlite3.Row | None:
        """Oldest queued catch-up item, or None when the queue is empty."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM catchup WHERE chat_key = ? AND status = 'queued'"
                " ORDER BY ts ASC, id ASC LIMIT 1",
                (chat_key,),
            ).fetchone()
        return row

    def asked_catchup(self, chat_key: str) -> sqlite3.Row | None:
        """The catch-up item currently shown to the user, if any."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM catchup WHERE chat_key = ? AND status = 'asked'"
                " ORDER BY id ASC LIMIT 1",
                (chat_key,),
            ).fetchone()
        return row

    def mark_catchup(self, row_id: int, status: str) -> None:
        """Set one catch-up row's status (``queued`` / ``asked`` / ``done`` / ``skipped``)."""
        with self._lock:
            self._conn.execute(
                "UPDATE catchup SET status = ? WHERE id = ?", (status, row_id)
            )
            self._conn.commit()

    def catchup_count(self, chat_key: str, status: str = "queued") -> int:
        """How many catch-up rows for a chat sit in one status."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM catchup WHERE chat_key = ? AND status = ?",
                (chat_key, status),
            ).fetchone()
        return int(row["n"])

    def has_catchup(self, message_id: str) -> bool:
        """True when this message was already queued (in any status)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM catchup WHERE message_id = ? LIMIT 1", (message_id,)
            ).fetchone()
        return row is not None

    def purge_catchup(self, keep_days: int) -> int:
        """Drop finished catch-up rows older than ``keep_days`` (0 = all finished)."""
        cutoff = now_ts() - keep_days * 86400
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM catchup WHERE created_at <= ?"
                " AND status IN ('done', 'skipped')",
                (cutoff,),
            )
            self._conn.commit()
        return cur.rowcount

    def clear_catchup(self, chat_key: str) -> None:
        """Drop every unfinished catch-up row for a chat."""
        with self._lock:
            self._conn.execute(
                "DELETE FROM catchup WHERE chat_key = ? AND status IN ('queued', 'asked')",
                (chat_key,),
            )
            self._conn.commit()

    def pending_messages(self, limit: int) -> list[sqlite3.Row]:
        """Oldest messages that have not been processed yet."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE batch_id IS NULL"
                " ORDER BY ts ASC LIMIT ?",
                (limit,),
            ).fetchall()
        return list(rows)

    def claim_batch(self, batch_id: int, limit: int) -> list[sqlite3.Row]:
        """Atomically claim the next batch of unprocessed messages."""
        with self._lock:
            rows = self.pending_messages(limit)
            if not rows:
                return []
            ids = [r["message_id"] for r in rows]
            self._conn.executemany(
                "UPDATE messages SET batch_id = ? WHERE message_id = ?",
                [(batch_id, mid) for mid in ids],
            )
            self._conn.commit()
        return rows

    def release_batch(self, batch_id: int) -> None:
        """Return a claimed batch to the pending pool (used on API failure)."""
        with self._lock:
            self._conn.execute(
                "UPDATE messages SET batch_id = NULL WHERE batch_id = ?",
                (batch_id,),
            )
            self._conn.commit()

    def purge_old_messages(self, keep_days: int) -> int:
        """Delete raw messages older than ``keep_days``."""
        cutoff = now_ts() - keep_days * 86400
        with self._lock:
            cur = self._conn.execute("DELETE FROM messages WHERE ts < ?", (cutoff,))
            self._conn.commit()
        return cur.rowcount

    # ------------------------------------------------------------------ 追问

    def claim_followups(self, rows: list[dict]) -> list[dict]:
        """把"准备去问"的任务标成已问，只返回真正新占到的那些。

        Args:
            rows: 每项含 ``id`` / ``title`` / ``date`` / ``clock``。

        Returns:
            本次新占到的条目；同一 (task_id, day) 以前问过就不再返回。
        """
        claimed: list[dict] = []
        stamp = now_ts()
        with self._lock:
            for row in rows:
                cur = self._conn.execute(
                    "INSERT OR IGNORE INTO followups"
                    " (task_id, day, title, clock, status, asked_at)"
                    " VALUES (?, ?, ?, ?, 'asked', ?)",
                    (
                        str(row.get("id")),
                        str(row.get("date")),
                        str(row.get("title") or ""),
                        str(row.get("clock") or ""),
                        stamp,
                    ),
                )
                if cur.rowcount > 0:
                    claimed.append(row)
            self._conn.commit()
        return claimed

    def open_followups(self, ttl_hours: int = 8) -> list[dict]:
        """还没回答的追问（按提问顺序），过期的自动忽略。"""
        cutoff = now_ts() - max(1, int(ttl_hours)) * 3600
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM followups WHERE status = 'asked' AND asked_at >= ?"
                " ORDER BY asked_at ASC, id ASC",
                (cutoff,),
            ).fetchall()
        return [dict(row) for row in rows]

    def resolve_followups(self, ids: list[int], status: str) -> None:
        """把若干条追问标成 ``done``（已完成）/``skipped``（没做）。"""
        if not ids:
            return
        with self._lock:
            self._conn.executemany(
                "UPDATE followups SET status = ?, answered_at = ? WHERE id = ?",
                [(status, now_ts(), int(row_id)) for row_id in ids],
            )
            self._conn.commit()

    def drop_followup(self, task_id: str, day: str) -> None:
        """删掉一条追问记录（发送失败时用来重试）。"""
        with self._lock:
            self._conn.execute(
                "DELETE FROM followups WHERE task_id = ? AND day = ?",
                (str(task_id), str(day)),
            )
            self._conn.commit()

    def purge_followups(self, keep_days: int) -> int:
        """清掉旧的追问记录。"""
        cutoff = now_ts() - max(1, int(keep_days)) * 86400
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM followups WHERE asked_at < ?", (cutoff,)
            )
            self._conn.commit()
        return cur.rowcount

    # ------------------------------------------------------------------ 事件

    def find_similar_event(
        self,
        title_norm: str,
        start_at: int | None,
        tolerance_sec: int = 600,
    ) -> sqlite3.Row | None:
        """Look up an existing event that matches title and start time."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM events WHERE title_norm = ? AND status != 'cancelled'"
                " ORDER BY id DESC LIMIT 1",
                (title_norm,),
            ).fetchone()
        if row is None:
            return None
        old_start = row["start_at"]
        if start_at is None or old_start is None:
            return row if start_at == old_start else None
        return row if abs(int(old_start) - start_at) <= tolerance_sec else None

    def add_event(
        self,
        *,
        title: str,
        title_norm: str,
        start_at: int | None,
        end_at: int | None,
        all_day: bool,
        location: str | None,
        participants: str,
        group_id: str | None,
        source_msg_ids: str,
        raw_excerpt: str,
        confidence: float,
        status: str,
    ) -> int:
        """Insert an event and return its id."""
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO events (title, title_norm, start_at, end_at, all_day,"
                " location, participants, group_id, source_msg_ids, raw_excerpt,"
                " confidence, status, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    title,
                    title_norm,
                    start_at,
                    end_at,
                    1 if all_day else 0,
                    location,
                    participants,
                    group_id,
                    source_msg_ids,
                    raw_excerpt,
                    confidence,
                    status,
                    now_ts(),
                ),
            )
            self._conn.commit()
            return int(cur.lastrowid or 0)

    def get_event(self, event_id: int) -> sqlite3.Row | None:
        """Fetch one event by id."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM events WHERE id = ?", (event_id,)
            ).fetchone()
        return row

    def events_between(self, start_ts: int, end_ts: int) -> list[sqlite3.Row]:
        """Confirmed events whose start time falls inside a window."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM events WHERE start_at IS NOT NULL"
                " AND start_at >= ? AND start_at < ?"
                " AND status IN ('confirmed', 'done')"
                " ORDER BY start_at ASC",
                (start_ts, end_ts),
            ).fetchall()
        return list(rows)

    def pending_events(self) -> list[sqlite3.Row]:
        """Events waiting for the owner to confirm them."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM events WHERE status = 'pending' ORDER BY id DESC LIMIT 50"
            ).fetchall()
        return list(rows)

    def set_event_status(self, event_id: int, status: str) -> bool:
        """Update an event status and drop its pending reminders when needed."""
        with self._lock:
            cur = self._conn.execute(
                "UPDATE events SET status = ? WHERE id = ?", (status, event_id)
            )
            if status in {"cancelled", "done"}:
                self._conn.execute(
                    "UPDATE reminders SET sent_at = -1"
                    " WHERE event_id = ? AND sent_at IS NULL",
                    (event_id,),
                )
            self._conn.commit()
            return cur.rowcount > 0

    # ------------------------------------------------------------------ 提醒

    def add_reminder(self, event_id: int, fire_at: int, kind: str) -> None:
        """Schedule one reminder if the fire time is still in the future."""
        with self._lock:
            self._conn.execute(
                "INSERT INTO reminders (event_id, fire_at, kind, sent_at)"
                " VALUES (?, ?, ?, NULL)",
                (event_id, fire_at, kind),
            )
            self._conn.commit()

    def due_reminders(self, at_ts: int) -> list[sqlite3.Row]:
        """Unsents reminders whose fire time has arrived."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT r.*, e.title, e.start_at, e.end_at, e.location, e.group_id,"
                " e.all_day"
                " FROM reminders r JOIN events e ON e.id = r.event_id"
                " WHERE r.sent_at IS NULL AND r.fire_at <= ?"
                "   AND e.status = 'confirmed'"
                " ORDER BY r.fire_at ASC LIMIT 20",
                (at_ts,),
            ).fetchall()
        return list(rows)

    def mark_reminder_sent(self, reminder_id: int, sent_at: int) -> None:
        """Mark a reminder as handled; ``-1`` means skipped without sending."""
        with self._lock:
            self._conn.execute(
                "UPDATE reminders SET sent_at = ? WHERE id = ?",
                (sent_at, reminder_id),
            )
            self._conn.commit()

    # ------------------------------------------------------------------ 状态

    def get_state(self, key: str, default: str = "") -> str:
        """Read a value from the tiny key/value table."""
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM state WHERE key = ?", (key,)
            ).fetchone()
        return default if row is None else str(row["value"])

    def set_state(self, key: str, value: str) -> None:
        """Write a value into the tiny key/value table."""
        with self._lock:
            self._conn.execute(
                "INSERT INTO state (key, value) VALUES (?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            self._conn.commit()

    def close(self) -> None:
        """Close the underlying connection."""
        with self._lock:
            self._conn.close()


def summarize_row(row: Any) -> dict[str, Any]:
    """Convert a sqlite row into a plain dict for logging and tests."""
    return dict(row) if row is not None else {}
