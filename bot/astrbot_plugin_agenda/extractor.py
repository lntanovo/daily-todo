"""Extraction helpers: prompt building, JSON parsing and normalisation.

Kept free of AstrBot imports so the parsing logic can be unit tested alone.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))

SYSTEM_PROMPT = """你是一个日程抽取器。用户会给你一段群聊记录，你要找出其中确定的时间安排与待办事项。

规则：
1. 只抽取"有明确时间或明确到期要求"的事项。闲聊、玩笑、假设、否定句一律忽略。
2. start_at 必须是 ISO 8601 且带 +08:00 时区，格式 2026-11-14T15:00:00+08:00。
3. 只有日期没有具体时刻的，设为当天 09:00，并把 all_day 设为 true。
4. 无法确定具体日期或时刻的，start_at 设为 null，不要猜。
5. 一句话里有多个互不相关的事项，拆成多条。
6. title 用 20 字以内概括，不要带"提醒""记得"这类词。
7. confidence 是你对该条抽取正确的把握，0 到 1 之间。含糊其辞的给 0.5 以下。
8. source_msg_ids 填支撑该事项的消息 id，可能有多条。
9. 只输出 JSON，不要任何解释文字，不要 markdown 代码块。

输出格式：
{"events":[{"title":"","start_at":null,"end_at":null,"all_day":false,
"location":null,"participants":[],"source_msg_ids":[],"confidence":0.0}]}"""


@dataclass
class DraftEvent:
    """One event candidate produced by the model."""

    title: str
    start_at: int | None = None
    end_at: int | None = None
    all_day: bool = False
    location: str | None = None
    participants: list[str] = field(default_factory=list)
    source_msg_ids: list[str] = field(default_factory=list)
    confidence: float = 0.0


def build_prompt(
    rows: list[dict],
    *,
    now: datetime | None = None,
    max_chars: int = 200,
) -> str:
    """Render message rows into the user prompt sent to the model.

    Args:
        rows: Mapping-like rows with ``ts``, ``sender_name``, ``text``, ``message_id``.
        now: Reference time, defaults to the current UTC+8 time.
        max_chars: Per-message truncation length.

    Returns:
        The user prompt text.
    """
    now = now or datetime.now(CST)
    lines = [
        f"今天是 {now:%Y-%m-%d} {now:%H:%M}（周{'一二三四五六日'[now.weekday()]}），时区 Asia/Shanghai。",
        "以下是群聊记录，每行格式为 [消息id] 时间 昵称: 内容",
        "",
    ]
    for row in rows:
        ts = int(row["ts"])
        stamp = datetime.fromtimestamp(ts, CST).strftime("%m-%d %H:%M")
        name = str(row["sender_name"] or "群友").replace("\n", " ")
        text = str(row["text"] or "").replace("\n", " ").strip()
        if len(text) > max_chars:
            text = text[:max_chars] + "…"
        lines.append(f"[{row['message_id']}] {stamp} {name}: {text}")
    lines.append("")
    lines.append("请按系统提示的 JSON 格式输出。没有可抽取的事项时输出 {\"events\":[]}。")
    return "\n".join(lines)


def extract_json_block(text: str) -> str:
    """Pull the outermost JSON object out of a model reply.

    Args:
        text: Raw model output, possibly wrapped in a markdown fence.

    Returns:
        The substring from the first ``{`` to the matching last ``}``.

    Raises:
        ValueError: When no JSON object is present.
    """
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw).strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("model reply contains no JSON object")
    return raw[start : end + 1]


def _parse_dt(value: object) -> int | None:
    """Parse an ISO 8601 string into a UNIX timestamp in UTC+8.

    Args:
        value: A date/time string, or ``None``.

    Returns:
        UNIX seconds, or ``None`` when the value is empty or unparsable.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=CST)
    return int(dt.timestamp())


def normalize_title(title: str) -> str:
    """Normalise a title so duplicates collapse to the same key.

    Args:
        title: Raw event title.

    Returns:
        Lower-cased, punctuation-stripped, whitespace-free title.
    """
    text = unicodedata.normalize("NFKC", title or "").lower()
    text = re.sub(r"[\s\u3000]+", "", text)
    text = re.sub(r"[，。！？、：；,.!?:;~\-—_（）()\[\]【】\"'“”‘’]", "", text)
    return text[:60]


def parse_events(text: str) -> list[DraftEvent]:
    """Parse a model reply into event drafts.

    Args:
        text: Raw model output.

    Returns:
        Parsed drafts; entries lacking a title are dropped.

    Raises:
        ValueError: When the reply is not valid JSON or has the wrong shape.
    """
    payload = json.loads(extract_json_block(text))
    if not isinstance(payload, dict):
        raise ValueError("top level JSON must be an object")
    items = payload.get("events", [])
    if not isinstance(items, list):
        raise ValueError("'events' must be a list")

    drafts: list[DraftEvent] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        start_at = _parse_dt(item.get("start_at"))
        end_at = _parse_dt(item.get("end_at"))
        if start_at is not None and end_at is not None and end_at < start_at:
            end_at = None
        participants = item.get("participants") or []
        if not isinstance(participants, list):
            participants = [str(participants)]
        source_ids = item.get("source_msg_ids") or []
        if not isinstance(source_ids, list):
            source_ids = [str(source_ids)]
        location = item.get("location")
        confidence = item.get("confidence", 0.0)
        try:
            confidence_f = float(confidence)
        except (TypeError, ValueError):
            confidence_f = 0.0
        drafts.append(
            DraftEvent(
                title=title[:80],
                start_at=start_at,
                end_at=end_at,
                all_day=bool(item.get("all_day", False)),
                location=str(location)[:120] if location else None,
                participants=[str(p)[:40] for p in participants][:10],
                source_msg_ids=[str(s) for s in source_ids][:20],
                confidence=max(0.0, min(1.0, confidence_f)),
            )
        )
    return drafts


def is_worth_storing(text: str, min_len: int = 4) -> bool:
    """Decide whether a group message is worth persisting.

    Args:
        text: Plain text of the message.
        min_len: Minimum number of non-space characters.

    Returns:
        True when the text carries enough signal to bother storing.
    """
    body = (text or "").strip()
    if len(body) < min_len:
        return False
    # Drop pure punctuation / emoji / whitespace, which carry no schedule signal.
    meaningful = [ch for ch in body if unicodedata.category(ch)[0] in {"L", "N"}]
    return len(meaningful) >= max(2, min_len // 2)
