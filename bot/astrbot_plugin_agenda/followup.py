"""任务到点后的"完成了吗"追问：判定该问哪些、解析回复、渲染文案。

调度和落库在 ``main.py``，这里只做纯计算，方便单测：

* :func:`due_rows`      —— 哪些任务已经过了时间、还没勾完成；
* :func:`render_question` —— 一次问一批（不刷屏）；
* :func:`selection`     —— "完成 / 1 3 / 没做" 三种回复怎么理解。

设计取舍：只在任务自己的时间点之后问一次，问过一次就记住（``followups`` 表），
当天不再重复；错过了（关机）就等下次开机时补问，超过 ``stale_hours`` 就不追了。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from .capture import parse_selection
from .cloud_reader import parse_date

DEFAULT_TIME = "20:00"
GRACE_MIN = 15
STALE_HOURS = 12
MAX_ITEMS = 6
OPEN_TTL_HOURS = 8

NOT_DONE_WORDS = {"没做", "还没", "没完成", "不做", "算了", "跳过", "skip", "no", "0"}
DONE_LEAD = re.compile(
    r"^(?:全部|都|已经|已)*\s*(?:完成|做完(?:了|啦)?|搞(?:定|掂)|done|ok|OK)"
    r"[:：,，、\s]*(.*)$",
    re.I,
)


def clock_of(row: dict) -> str:
    """任务时间 ``HH:MM``；没有就用默认时间。"""
    raw = str(row.get("time") or "")[:5]
    return raw if re.fullmatch(r"\d{2}:\d{2}", raw) else DEFAULT_TIME


def due_rows(
    rows: list[dict],
    *,
    now: datetime,
    grace_min: int = GRACE_MIN,
    stale_hours: int = STALE_HOURS,
    limit: int = MAX_ITEMS,
) -> list[dict]:
    """挑出"到点了、还没完成"的条目，按时间排序。

    Args:
        rows: ``Overview.today_items`` 与 ``Overview.overdue`` 的合集，每项含
            ``id`` / ``title`` / ``date`` / ``time``。
        now: 当前时间（UTC+8）。
        grace_min: 到点后等几分钟再问，避免刚开课就问"完成了吗"。
        stale_hours: 超过这个时长的就不追了（关机太久的不打扰）。
        limit: 一次最多问几项，超过的塞进下一条消息。

    Returns:
        需要追问的条目（保持传入的字段，另外补 ``clock``）。
    """
    picked: list[dict] = []
    for row in rows:
        day = parse_date(row.get("date"))
        if day is None or not row.get("id"):
            continue
        clock = clock_of(row)
        hour, minute = (int(part) for part in clock.split(":"))
        due_at = datetime(
            day.year, day.month, day.day, hour, minute, tzinfo=now.tzinfo
        ) + timedelta(minutes=max(0, int(grace_min)))
        if now < due_at:
            continue
        if now - due_at > timedelta(hours=max(1, int(stale_hours))):
            continue
        picked.append({**row, "clock": clock})
    picked.sort(key=lambda item: (str(item.get("date") or ""), item["clock"]))
    return picked[: max(1, int(limit))]


def _when_label(row: dict, now: datetime) -> str:
    """``16:30`` 或 ``昨天 23:59``。"""
    day = parse_date(row.get("date"))
    clock = row.get("clock") or clock_of(row)
    if day is None:
        return clock
    gap = (now.date() - day).days
    if gap <= 0:
        return clock
    if gap == 1:
        return f"昨天 {clock}"
    return f"{day:%m-%d} {clock}"


def render_question(rows: list[dict], *, now: datetime) -> str:
    """一次追问的文案；多条时编号，回复用编号。"""
    if not rows:
        return ""
    if len(rows) == 1:
        row = rows[0]
        return "\n".join(
            [
                f"⏰ 「{row.get('title') or ''}」（{_when_label(row, now)}）到点了，完成了吗？",
                "回「完成」我标成已完成；回「没做」就不再问了。",
            ]
        )
    lines = [f"⏰ 这 {len(rows)} 项到点了，完成了吗？"]
    for index, row in enumerate(rows, 1):
        lines.append(f"{index}. {row.get('title') or ''}（{_when_label(row, now)}）")
    lines.append("回「完成」全部标完成；只完成其中几条就回编号，比如「1 3」；回「没做」就不再问。")
    return "\n".join(lines)


def selection(text: str, count: int) -> list[int] | None:
    """把回复解析成 1-based 编号列表。

    Returns:
        ``[]`` 表示"都没做"，``None`` 表示这句不是对追问的回答。
    """
    body = (text or "").strip()
    if not body or count <= 0:
        return None
    if body in NOT_DONE_WORDS:
        return []
    matched = DONE_LEAD.match(body)
    if matched is not None:
        rest = matched.group(1).strip()
        if not rest:
            return list(range(1, count + 1))
        picks = parse_selection(rest, count, ignore_commands=True)
        return picks if picks else list(range(1, count + 1))
    return parse_selection(body, count, ignore_commands=True)
