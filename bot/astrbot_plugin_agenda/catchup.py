"""Selection rules for the startup catch-up of missed private messages.

The QQ entry point only works while the PC is on: anything the owner sends
while it is off never reaches the plugin. On boot the plugin asks OneBot for
the recent friend history and replays the owner's messages through the usual
"draft -> confirm" flow. This module keeps the selection rules pure so they can
be unit tested without AstrBot, SQLite or a network connection.

Design notes:
    * Only messages from the owner are considered; the bot's own replies sit in
      the same history and must never be re-parsed.
    * Anything older than ``max_age_days`` is only counted, not prompted: it is
      usually stale by the time the machine comes back up.
    * The watermark only moves forward, so a repeated catch-up cannot ask the
      same message twice.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# 短于这个长度的消息里几乎没有日程信息（"好""1""嗯"），不值得花一次模型调用。
MIN_TEXT_LEN = 4

# OneBot 的 message 字段既可能是字符串，也可能是消息段数组。
def message_text(message: Any) -> str:
    """Extract the plain text of one OneBot message.

    Args:
        message: A OneBot message dict (as returned by the history API).

    Returns:
        Concatenated text segments, stripped. Empty when nothing is textual.
    """
    if not isinstance(message, dict):
        return ""
    body = message.get("message")
    if isinstance(body, str):
        return body.strip()
    if not isinstance(body, list):
        return ""
    parts: list[str] = []
    for segment in body:
        if not isinstance(segment, dict) or segment.get("type") != "text":
            continue
        data = segment.get("data")
        if isinstance(data, dict):
            parts.append(str(data.get("text") or ""))
    return "".join(parts).strip()


@dataclass
class MissedBatch:
    """The owner's messages that arrived after the watermark.

    Attributes:
        fresh: Prompt candidates, oldest first, each ``{message_id, ts, text}``.
        stale: Count of messages older than the max age (summarised, not asked).
        dropped: Count of fresh messages beyond ``limit`` (oldest dropped).
        newest_ts: Highest timestamp seen, the next watermark.
    """

    fresh: list[dict[str, Any]] = field(default_factory=list)
    stale: int = 0
    dropped: int = 0
    newest_ts: int = 0


def select_candidates(
    messages: Any,
    *,
    owner_id: str,
    since_ts: int,
    now: int,
    max_age_days: int = 7,
    min_len: int = MIN_TEXT_LEN,
    limit: int = 50,
) -> MissedBatch:
    """Pick the owner's unprocessed messages out of a history page.

    Args:
        messages: Raw ``messages`` list from ``get_friend_msg_history``.
        owner_id: QQ id of the owner; every other sender is ignored.
        since_ts: Only messages strictly newer than this count as missed.
        now: Current UNIX timestamp, used for the staleness cutoff.
        max_age_days: Messages older than this are counted, never prompted.
        min_len: Shortest text worth a model call.
        limit: Keep at most this many prompt candidates (newest win).

    Returns:
        A :class:`MissedBatch` describing what to ask and the next watermark.
    """
    owner = str(owner_id)
    since = max(0, int(since_ts))
    cutoff_old = int(now) - int(max_age_days) * 86400
    batch = MissedBatch(newest_ts=since)

    for message in messages or []:
        if not isinstance(message, dict):
            continue
        try:
            ts = int(message.get("time") or 0)
        except (TypeError, ValueError):
            continue
        if ts <= since:
            continue
        if str(message.get("user_id") or "") != owner:
            continue
        # 水位按"主人的最新一条"推进，短消息也算处理过，避免每次开机重扫。
        batch.newest_ts = max(batch.newest_ts, ts)
        text = message_text(message)
        if len(text) < min_len:
            continue
        message_id = str(message.get("message_id") or "")
        if not message_id:
            continue
        if ts < cutoff_old:
            batch.stale += 1
            continue
        batch.fresh.append({"message_id": message_id, "ts": ts, "text": text})

    batch.fresh.sort(key=lambda row: (row["ts"], row["message_id"]))
    if limit > 0 and len(batch.fresh) > limit:
        batch.dropped = len(batch.fresh) - limit
        batch.fresh = batch.fresh[-limit:]
    return batch
