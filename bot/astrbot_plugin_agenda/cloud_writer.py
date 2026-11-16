"""Write captured agenda items into the CloudBase PostgreSQL task table.

The QQ bot is a capture surface, not a second database: everything it records
lands in the same `todo_tasks` table the web app uses. This module owns the
validation and the HTTP calls, and is written so it can be unit tested with a
fake transport (no network, no AstrBot import).
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import date as date_cls
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
KINDS = ("deadline", "event", "task")
DEFAULT_CLOCK = "20:00"


class WriterError(RuntimeError):
    """Raised when the cloud refuses a write."""


def is_valid_date(value: str) -> bool:
    """Return True when ``value`` is a real calendar date in YYYY-MM-DD form."""
    if not DATE_RE.match(value or ""):
        return False
    try:
        return date_cls.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def normalize(payload: dict[str, Any], owner_id: str) -> dict[str, Any]:
    """Validate one captured item into a ``todo_tasks`` row.

    Args:
        payload: ``title``, ``date``, optional ``time`` and ``kind``.
        owner_id: The account the task belongs to.

    Returns:
        The row to insert.

    Raises:
        WriterError: With a stable code when a field is unusable.
    """
    title = re.sub(r"\s+", " ", str(payload.get("title") or "")).strip()
    if not title or len(title) > 160:
        raise WriterError("INVALID_TITLE")

    when = str(payload.get("date") or "").strip()
    if not is_valid_date(when):
        raise WriterError("INVALID_DATE")

    clock = str(payload.get("time") or "").strip()
    if clock and not TIME_RE.match(clock):
        raise WriterError("INVALID_TIME")

    kind = str(payload.get("kind") or "task").strip()
    if kind not in KINDS:
        raise WriterError("INVALID_KIND")

    return {
        "owner_id": owner_id,
        "id": str(uuid.uuid4()),
        "title": title,
        "type": "single",
        "task_date": when,
        # 没有具体时刻的截止日，当天 20:00 提醒一次；更早的倒计时交给早报。
        "remind_time": clock or DEFAULT_CLOCK,
        "remind_enabled": True,
        "priority": "normal",
    }


class CloudWriter:
    """Minimal PostgREST client for the one table the bot may write."""

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
        """True when the bot has everything it needs to write."""
        return bool(self.api_key and self.owner_id)

    # ---------------------------------------------------------------- 传输层

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
        except URLError as error:  # 网络层失败统一成 0，调用方按失败的语义处理
            raise WriterError(f"NETWORK: {error.reason}") from error

    def _call(self, method: str, path: str, body: Any = None, prefer: str | None = None) -> Any:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if method == "POST":
            headers["Prefer"] = prefer or "return=representation"
        payload = json.dumps(body, ensure_ascii=False) if body is not None else None
        status, text = self._request(method, f"{self.base}{path}", headers, payload)
        if status >= 400:
            raise WriterError(f"HTTP_{status}: {text[:200]}")
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise WriterError("INVALID_RESPONSE") from error

    # ---------------------------------------------------------------- 业务层

    def find_existing(self, row: dict[str, Any]) -> str | None:
        """Return the id of an identical task on the same day, if any."""
        from urllib.parse import quote

        query = (
            "?owner_id=eq." + quote(str(row["owner_id"]), safe="")
            + "&task_date=eq." + quote(str(row["task_date"]), safe="")
            + "&title=eq." + quote(str(row["title"]), safe="")
            + "&deleted_at=is.null&select=id&limit=1"
        )
        found = self._call("GET", f"/todo_tasks{query}")
        if isinstance(found, list) and found:
            return str(found[0].get("id") or "") or None
        return None

    def write(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Validate and insert one task, collapsing exact duplicates.

        Returns:
            ``{"id", "date", "time", "title", "duplicate"}``.
        """
        row = normalize(payload, self.owner_id)
        existing = self.find_existing(row)
        if existing:
            return {
                "id": existing,
                "date": row["task_date"],
                "time": row["remind_time"],
                "title": row["title"],
                "duplicate": True,
            }
        self._call("POST", "/todo_tasks", row)
        return {
            "id": row["id"],
            "date": row["task_date"],
            "time": row["remind_time"],
            "title": row["title"],
            "duplicate": False,
        }

    def complete(self, task_id: str, day: str) -> dict[str, Any]:
        """Mark one task as done on one day, the way the site does it.

        站点把"完成"记在 ``todo_daily_completions``（主键 owner/task/day），
        往这张表 upsert 一条 ``completed = true`` 就等于勾了复选框，完成历史由
        数据库触发器维护。重复标记是幂等的。

        Args:
            task_id: ``todo_tasks.id``。
            day: 完成日期 ``YYYY-MM-DD``。

        Returns:
            ``{"task_id", "date"}``。

        Raises:
            WriterError: 参数不合法或云端拒绝写入。
        """
        if not str(task_id or "").strip():
            raise WriterError("INVALID_TASK")
        if not is_valid_date(day):
            raise WriterError("INVALID_DATE")
        row = {
            "owner_id": self.owner_id,
            "task_id": str(task_id),
            "completion_date": day,
            "completed": True,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self._call(
            "POST",
            "/todo_daily_completions?on_conflict=owner_id,task_id,completion_date",
            [row],
            prefer="resolution=merge-duplicates,return=representation",
        )
        return {"task_id": str(task_id), "date": day}
