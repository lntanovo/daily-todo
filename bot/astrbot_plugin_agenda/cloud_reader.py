"""Read-only task overview for chat commands like ``/任务``.

The bot owns writes through :mod:`cloud_writer`; reads need the same
``todo_tasks`` data the site shows, so this module queries the same PostgREST
endpoint and rebuilds the site's own appearance rules:

    * ``single``  tasks appear on ``task_date`` only;
    * ``range``   tasks appear on every day between ``start_date``/``end_date``;
    * ``recurring`` tasks follow ``todo_task_recurrences`` (weekly weekdays or a
      monthly day-of-month), bounded by the rule's own start/end dates.

A task counts as finished on a day when ``todo_daily_completions`` has a
``completed = true`` row for ``(task_id, that day)``. The transport is
injectable so the whole overview can be unit tested without a network.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

CST = timezone(timedelta(hours=8))

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CLOCK_RE = re.compile(r"^(\d{2}:\d{2})")

TASK_SELECT = (
    "id,title,type,task_date,start_date,end_date,"
    "remind_time,start_time,priority,remind_enabled"
)
RECURRENCE_SELECT = "task_id,frequency,weekdays,month_day,start_date,end_date"
SETTINGS_SELECT = (
    "digest_time,evening_time,remind_lead_days,quiet_start,quiet_end,"
    "digest_enabled,evening_enabled"
)


class ReaderError(RuntimeError):
    """Raised when the cloud refuses a read."""


def parse_date(value: Any) -> date | None:
    """Parse a ``YYYY-MM-DD`` string, or return None."""
    if not isinstance(value, str) or not DATE_RE.match(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def clock_of(task: dict[str, Any]) -> str:
    """Display clock for a task: its reminder time, else its start time."""
    for key in ("remind_time", "start_time"):
        match = CLOCK_RE.match(str(task.get(key) or ""))
        if match:
            return match.group(1)
    return ""


def rule_appears(rule: dict[str, Any] | None, day: date) -> bool:
    """Whether a recurrence rule covers one calendar day."""
    if not isinstance(rule, dict):
        return False
    start = parse_date(rule.get("start_date"))
    if start is None or day < start:
        return False
    end = parse_date(rule.get("end_date"))
    if end is not None and day > end:
        return False
    frequency = rule.get("frequency")
    if frequency == "weekly":
        weekdays = {int(x) for x in (rule.get("weekdays") or []) if str(x).isdigit()}
        return day.isoweekday() in weekdays
    if frequency == "monthly":
        return rule.get("month_day") == day.day
    return False


def appears_on(
    task: dict[str, Any],
    day: date,
    recurrences: dict[str, dict[str, Any]],
) -> bool:
    """Whether a task shows up on one calendar day."""
    kind = task.get("type")
    if kind == "single":
        return parse_date(task.get("task_date")) == day
    if kind == "range":
        start = parse_date(task.get("start_date"))
        end = parse_date(task.get("end_date"))
        return start is not None and end is not None and start <= day <= end
    if kind == "recurring":
        return rule_appears(recurrences.get(str(task.get("id"))), day)
    return False


@dataclass
class Overview:
    """Everything ``/任务`` renders.

    Attributes:
        today: The reference day in Asia/Shanghai.
        overdue: Single-day tasks past their date, oldest first.
        today_items: Tasks that appear today and are not finished.
        upcoming: Tasks for the next ``days`` days, flattened per day.
        days: Width of the upcoming window.
        lead_days: The owner's countdown setting, shown in the footer.
        truncated: How many items were cut from the message (per section cap).
    """

    today: date
    overdue: list[dict[str, Any]] = field(default_factory=list)
    today_items: list[dict[str, Any]] = field(default_factory=list)
    upcoming: list[dict[str, Any]] = field(default_factory=list)
    days: int = 7
    lead_days: int = 3
    truncated: int = 0


def _completed_set(rows: Any) -> set[tuple[str, str]]:
    done: set[tuple[str, str]] = set()
    for row in rows or []:
        if not isinstance(row, dict) or row.get("completed") is False:
            continue
        task_id = str(row.get("task_id") or "")
        day = str(row.get("completion_date") or "")[:10]
        if task_id and DATE_RE.match(day):
            done.add((task_id, day))
    return done


def build_overview(
    tasks: list[dict[str, Any]],
    recurrences: list[dict[str, Any]],
    completions: list[dict[str, Any]],
    *,
    today: date,
    days: int = 7,
    lead_days: int = 3,
    max_overdue: int = 10,
    max_today: int = 10,
    max_upcoming: int = 15,
) -> Overview:
    """Group the owner's unfinished tasks into overdue / today / upcoming."""
    rules = {
        str(rule.get("task_id")): rule
        for rule in recurrences or []
        if isinstance(rule, dict) and rule.get("task_id")
    }
    done = _completed_set(completions)
    rows = [task for task in tasks or [] if isinstance(task, dict)]

    def item(task: dict[str, Any], day: date) -> dict[str, Any]:
        return {
            "id": str(task.get("id") or ""),
            "title": str(task.get("title") or ""),
            "date": day.isoformat(),
            "time": clock_of(task),
            "days": (day - today).days,
            "priority": str(task.get("priority") or "normal"),
        }

    def finished(task: dict[str, Any], day: date) -> bool:
        return (str(task.get("id") or ""), day.isoformat()) in done

    overdue: list[dict[str, Any]] = []
    for task in rows:
        if task.get("type") != "single":
            continue
        day = parse_date(task.get("task_date"))
        if day is None or day >= today or (today - day).days > 30:
            continue
        if finished(task, day):
            continue
        overdue.append(item(task, day))
    overdue.sort(key=lambda row: (row["date"], row["time"], row["title"]))

    today_items = [
        item(task, today)
        for task in rows
        if appears_on(task, today, rules) and not finished(task, today)
    ]
    today_items.sort(key=lambda row: (row["time"] or "99:99", row["title"]))

    upcoming: list[dict[str, Any]] = []
    for offset in range(1, max(0, int(days)) + 1):
        day = today + timedelta(days=offset)
        for task in rows:
            if appears_on(task, day, rules) and not finished(task, day):
                upcoming.append(item(task, day))
    upcoming.sort(key=lambda row: (row["date"], row["time"] or "99:99", row["title"]))

    truncated = 0
    for group, cap in (
        (overdue, max_overdue),
        (today_items, max_today),
        (upcoming, max_upcoming),
    ):
        if len(group) > cap:
            truncated += len(group) - cap
            del group[cap:]

    return Overview(
        today=today,
        overdue=overdue,
        today_items=today_items,
        upcoming=upcoming,
        days=max(0, int(days)),
        lead_days=max(0, int(lead_days)),
        truncated=truncated,
    )


def _when(row: dict[str, Any], today: date) -> str:
    """Human label for one item: 今天 / 明天 / MM-DD, plus the clock."""
    day = parse_date(row.get("date"))
    days = (day - today).days if day else 0
    if days == 0:
        label = "今天"
    elif days == 1:
        label = "明天"
    elif days == 2:
        label = "后天"
    else:
        label = day.strftime("%m-%d") if day else str(row.get("date") or "")
    clock = f" {row['time']}" if row.get("time") else ""
    return f"{label}{clock}"


def format_overview(overview: Overview, *, title: str | None = None) -> str:
    """Render an overview as one chat message.

    Args:
        overview: The grouped task data.
        title: Optional first line; defaults to the ``/任务`` header.
    """
    lines = [
        title
        or f"📋 任务总览（{overview.today:%m-%d} 周{'一二三四五六日'[overview.today.weekday()]}）"
    ]
    total = len(overview.overdue) + len(overview.today_items) + len(overview.upcoming)
    if total == 0:
        lines.append("现在没有未完成的任务 🎉")
        return "\n".join(lines)

    if overview.overdue:
        lines.append(f"\n⚠️ 逾期 {len(overview.overdue)} 项")
        for row in overview.overdue:
            late = abs(int(row.get("days") or 0))
            lines.append(f"· {row['date']} {row['title']}（逾期 {late} 天）")

    if overview.today_items:
        lines.append(f"\n📌 今天 {len(overview.today_items)} 项")
        for row in overview.today_items:
            mark = " 🔴" if row.get("priority") == "urgent" else ""
            lines.append(f"· {_when(row, overview.today)} {row['title']}{mark}")

    if overview.upcoming:
        lines.append(f"\n⏳ 未来 {overview.days} 天 {len(overview.upcoming)} 项")
        for row in overview.upcoming:
            gap = f"（{row['days']} 天后）" if row.get("days", 0) > 2 else ""
            lines.append(f"· {_when(row, overview.today)} {row['title']}{gap}")

    if overview.truncated:
        lines.append(f"\n…还有 {overview.truncated} 项没列出，去站点看完整清单。")
    return "\n".join(lines)


def format_settings(settings: dict[str, Any] | None) -> str:
    """Render the reminder settings block for ``/提醒``."""
    if not settings:
        return "还没配提醒设置，去站点「提醒设置」里开一下。"

    def clock(value: Any) -> str:
        match = CLOCK_RE.match(str(value or ""))
        return match.group(1) if match else "—"

    quiet_start = clock(settings.get("quiet_start")) if settings.get("quiet_start") else ""
    quiet_end = clock(settings.get("quiet_end")) if settings.get("quiet_end") else ""
    quiet = f"{quiet_start}–{quiet_end}" if quiet_start and quiet_end else "未设置"
    return "\n".join(
        [
            "⏰ 提醒设置",
            f"· 早报 {clock(settings.get('digest_time'))}"
            f"（{'开' if settings.get('digest_enabled') else '关'}）",
            f"· 晚间收尾 {clock(settings.get('evening_time'))}"
            f"（{'开' if settings.get('evening_enabled') else '关'}）",
            f"· 提前 {int(settings.get('remind_lead_days') or 0)} 天开始倒计时",
            f"· 免打扰 {quiet}",
            "· 到点提醒按任务自己的时间发",
        ]
    )


class CloudReader:
    """Minimal PostgREST reader for the task tables."""

    def __init__(
        self,
        env_id: str,
        api_key: str,
        owner_id: str,
        *,
        request: Callable[[str, str, dict[str, str], str | None], tuple[int, str]] | None = None,
        timeout: float = 15.0,
    ) -> None:
        self.base = f"https://{env_id}.api.tcloudbasegateway.com/v1/rdb/rest"
        self.api_key = api_key
        self.owner_id = owner_id
        self.timeout = timeout
        self._request = request or self._urllib_request

    @property
    def configured(self) -> bool:
        """True when the bot has everything it needs to read."""
        return bool(self.api_key and self.owner_id)

    def _urllib_request(
        self, method: str, url: str, headers: dict[str, str], body: str | None
    ) -> tuple[int, str]:
        request = Request(url, data=body.encode("utf-8") if body else None, method=method)
        for key, value in headers.items():
            request.add_header(key, value)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return response.status, response.read().decode("utf-8", "replace")
        except HTTPError as error:
            return error.code, error.read().decode("utf-8", "replace")
        except URLError as error:
            raise ReaderError(f"NETWORK: {error.reason}") from error

    def _get(self, path: str) -> list[dict[str, Any]]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
        }
        status, text = self._request("GET", f"{self.base}{path}", headers, None)
        if status >= 400:
            raise ReaderError(f"HTTP_{status}: {text[:200]}")
        if not text:
            return []
        try:
            data = json.loads(text)
        except json.JSONDecodeError as error:
            raise ReaderError("INVALID_RESPONSE") from error
        return [row for row in data if isinstance(row, dict)] if isinstance(data, list) else []

    def _owner_filter(self) -> str:
        return f"owner_id=eq.{quote(str(self.owner_id), safe='')}"

    def overview(self, *, days: int = 7, today: date | None = None) -> Overview:
        """Fetch and group the owner's unfinished tasks."""
        owner = self._owner_filter()
        tasks = self._get(
            f"/todo_tasks?{owner}&deleted_at=is.null&select={TASK_SELECT}"
        )
        recurrences = self._get(
            f"/todo_task_recurrences?{owner}&select={RECURRENCE_SELECT}"
        )
        completions = self._get(
            f"/todo_daily_completions?{owner}&completed=is.true"
            "&select=task_id,completion_date"
        )
        settings = self.settings_row()
        lead = int((settings or {}).get("remind_lead_days") or 3)
        return build_overview(
            tasks,
            recurrences,
            completions,
            today=today or datetime.now(CST).date(),
            days=days,
            lead_days=lead,
        )

    def settings_row(self) -> dict[str, Any] | None:
        """The owner's reminder settings row, or None when unset."""
        rows = self._get(
            f"/todo_reminder_settings?{self._owner_filter()}&select={SETTINGS_SELECT}"
        )
        return rows[0] if rows else None
