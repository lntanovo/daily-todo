"""AstrBot plugin: silently watch configured QQ groups, extract agenda items
and push reminders to the owner.

Design invariants:
    * Watched groups never receive a reply from this plugin. The whole
      ``watch_groups`` path ends with ``event.stop_event()``.
    * Raw messages are persisted before any model call, so a broken API never
      loses data.
    * Every model call is charged against a daily token budget.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star
from astrbot.api.web import error_response, json_response, request
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

from .cloud_writer import CloudWriter, WriterError
from .cloud_reader import CloudReader, ReaderError, format_overview, format_settings
from .catchup import select_candidates
from .capture import (
    CANCEL_WORDS,
    CAPTURE_SYSTEM_PROMPT,
    CONFIRM_WORDS,
    REPAIR_HINT,
    RETRY_WORDS,
    CaptureResult,
    build_capture_prompt,
    items_payload,
    looks_like_task,
    merge_items,
    missing_segments,
    parse_capture_reply,
    parse_selection,
    payload_items,
    render_draft,
    segment_message,
)
from .intent import DailyIntent, parse_clock, parse_daily_intent, push_due
from .followup import (
    OPEN_TTL_HOURS,
    due_rows,
    render_question,
    selection as followup_selection,
)
from .extractor import (
    SYSTEM_PROMPT,
    DraftEvent,
    build_prompt,
    is_worth_storing,
    normalize_title,
    parse_events,
)
from .guard import chat_group_ids, is_chat, is_watch, set_policy, watch_group_ids
from .store import CST, Store, format_ts, now_ts

PLUGIN_NAME = "astrbot_plugin_agenda"


def _as_number(value: str):
    """Return an int for purely numeric group ids, else the original string."""
    return int(value) if value.isdigit() else value


class Main(Star):
    """Agenda extraction and reminder plugin."""

    def __init__(self, context: Context, config: Any = None) -> None:
        super().__init__(context)
        self.conf = config if config is not None else {}
        self.store: Store | None = None
        self._tasks: list[asyncio.Task] = []
        self._batch_seq = 0
        self._last_extract = 0.0
        self._warned_no_umo = False
        context.register_web_api(
            f"/{PLUGIN_NAME}/groups",
            self.api_groups,
            ["GET"],
            "List QQ groups and the current chat/watch policy",
        )
        context.register_web_api(
            f"/{PLUGIN_NAME}/groups",
            self.api_save_groups,
            ["POST"],
            "Save the chat/watch policy for groups",
        )

    # ------------------------------------------------------------- 生命周期

    def _conf(self, key: str, default: Any) -> Any:
        """Read a plugin config value with a fallback."""
        try:
            value = self.conf.get(key, default)
        except AttributeError:
            return default
        return default if value is None else value

    @filter.on_astrbot_loaded()
    async def on_loaded(self) -> None:
        """Open the database and start the background workers."""
        self._ensure_started()

    def _ensure_started(self) -> None:
        """Start workers once, even if the plugin was hot-loaded after boot."""
        if self.store is not None:
            return
        data_dir = Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME
        self.store = Store(
            data_dir / "agenda.db",
            hourly_cap=int(self._conf("max_group_msgs_per_hour", 300)),
        )
        self.store.purge_catchup(int(self._conf("retention_days", 90)))
        self.store.purge_followups(int(self._conf("retention_days", 90)))
        set_policy(self._conf("chat_groups", []), self._conf("watch_groups", []))
        self._tasks.append(asyncio.create_task(self._extract_loop()))
        self._tasks.append(asyncio.create_task(self._reminder_loop()))
        self._tasks.append(asyncio.create_task(self._catchup_loop()))
        self._tasks.append(asyncio.create_task(self._daily_push_loop()))
        self._tasks.append(asyncio.create_task(self._followup_loop()))
        logger.info(
            "[agenda] started, chat=%s watch=%s",
            sorted(chat_group_ids()),
            sorted(watch_group_ids()),
        )

    async def terminate(self) -> None:
        """Cancel workers and close the database."""
        for task in self._tasks:
            task.cancel()
        self._tasks.clear()
        if self.store is not None:
            self.store.close()
            self.store = None
        logger.info("[agenda] stopped")

    # --------------------------------------------------------------- 消息入口

    @filter.event_message_type(filter.EventMessageType.PRIVATE_MESSAGE)
    async def on_private_message(self, event: AstrMessageEvent):
        """Capture schedule items from the owner's private chat.

        A single message may hold several tasks: the text is split into numbered
        segments first, the model answers per segment, and a coverage check makes
        sure no segment was skipped. Only messages that are genuinely chit-chat
        fall through to the normal chat handler.

        Args:
            event: The incoming private message.
        """
        try:
            admins = [
                str(x) for x in (self.context.get_config().get("admins_id") or [])
            ]
        except Exception:
            admins = []
        if str(event.get_sender_id()) not in admins:
            event.should_call_llm(False)
            event.stop_event()
            return

        if self.store is None:
            self._ensure_started()
        text = (event.message_str or "").strip()
        if self.store is None or not text:
            return

        chat_key = str(event.unified_msg_origin)
        self._remember_private(chat_key, event)
        pending = self.store.latest_pending(chat_key)

        if pending and text in RETRY_WORDS:
            event.should_call_llm(False)
            event.stop_event()
            yield event.plain_result(await self._retry_pending(chat_key, pending))
            return

        if pending and text in CONFIRM_WORDS:
            event.should_call_llm(False)
            event.stop_event()
            reply = await self._confirm_pending(pending, None)
            # 写入失败时草稿还在（_confirm_pending 不会删），此时不要推进补拉队列。
            saved = self.store.latest_pending(chat_key) is None
            nxt = self._advance_catchup(chat_key, "done") if saved else ""
            yield event.plain_result(reply + (f"\n\n{nxt}" if nxt else ""))
            return

        if pending and text in CANCEL_WORDS:
            self.store.drop_pending(int(pending["id"]))
            event.should_call_llm(False)
            event.stop_event()
            nxt = self._advance_catchup(chat_key, "skipped")
            yield event.plain_result("好，这条不记了。" + (f"\n\n{nxt}" if nxt else ""))
            return

        if pending:
            # 多条目草稿：允许"1 3""存 2"这种只挑几条的回复。
            try:
                drafted = payload_items(json.loads(pending["payload"]))
            except (TypeError, ValueError):
                drafted = []
            picks = parse_selection(text, len(drafted)) if len(drafted) > 1 else None
            if picks:
                event.should_call_llm(False)
                event.stop_event()
                reply = await self._confirm_pending(pending, picks)
                saved = self.store.latest_pending(chat_key) is None
                nxt = self._advance_catchup(chat_key, "done") if saved else ""
                yield event.plain_result(reply + (f"\n\n{nxt}" if nxt else ""))
                return

        # 到点追问「完成了吗」的回复：1 3 / 完成 / 没做。
        open_rows = self.store.open_followups(OPEN_TTL_HOURS)
        if open_rows:
            picks = followup_selection(text, len(open_rows))
            if picks is not None:
                event.should_call_llm(False)
                event.stop_event()
                yield event.plain_result(await self._apply_followup(picks, open_rows))
                return

        # "每天 9 点提醒我" 这类设置请求，先于日程解析处理。
        daily = parse_daily_intent(text)
        if daily is not None:
            event.should_call_llm(False)
            event.stop_event()
            yield event.plain_result(self._apply_daily_intent(daily))
            return

        result = await self._capture(text)

        if result.error and result.has_schedule:
            # 模型挂了：别让这条悄悄流去闲聊，留个草稿等用户回「重试」。
            event.should_call_llm(False)
            event.stop_event()
            if pending:
                self.store.drop_pending(int(pending["id"]))
            payload = items_payload([], raw=text, missing=result.missing)
            self.store.add_pending(chat_key, text, json.dumps(payload, ensure_ascii=False))
            yield event.plain_result(
                "这条里像是有安排，但我这次没解析出来（模型报错）。"
                "回「重试」我再试一次。"
            )
            return

        if not result.items and (result.kind == "chat" or not result.missing):
            if looks_like_task(text):
                event.should_call_llm(False)
                event.stop_event()
                yield event.plain_result(
                    "这句像是要记的事，但没说哪天。补一句时间就行，比如「周五 交作业」。"
                )
                return
            # 不像日程：不拦截，交给 AstrBot 正常聊天。
            return

        event.should_call_llm(False)
        event.stop_event()
        yield event.plain_result(await self._draft_for(chat_key, text, result, pending))

    async def _capture(self, text: str) -> CaptureResult:
        """Parse one private message into every schedule item it contains.

        先整条问一次；漏了段、或者模型直接把回复烧没了（推理型模型遇到长
        prompt 会把 token 全花在思考上、content 返回空），就换成"只问剩下的
        几段"的小 prompt 分批补抽——漏没漏是代码算出来的，不靠模型自觉。

        Returns:
            ``CaptureResult``; ``error`` is set when every attempt failed.
        """
        if len(text) < 4:
            return CaptureResult(kind="chat")

        segments = segment_message(
            text, max_segments=int(self._conf("capture_max_segments", 12))
        )
        provider = self._capture_provider()
        kind, items, error = "", [], None
        try:
            raw = await self._ask_model(
                build_capture_prompt(text, segments),
                system=CAPTURE_SYSTEM_PROMPT,
                provider_id=provider,
            )
            kind, items = parse_capture_reply(raw)
        except Exception as exc:  # 模型偶发失败不应该让私聊变成"没反应"
            error = str(exc)
            logger.warning("[agenda] capture failed: %s", exc)

        if bool(self._conf("capture_repair", True)):
            for _ in range(2):
                todo = missing_segments(segments, items)
                if not todo:
                    break
                for start in range(0, len(todo), 4):
                    chunk = todo[start : start + 4]
                    try:
                        raw = await self._ask_model(
                            build_capture_prompt(text, chunk, repair=True),
                            system=f"{CAPTURE_SYSTEM_PROMPT}\n\n{REPAIR_HINT}",
                            provider_id=provider,
                        )
                        _, more = parse_capture_reply(raw)
                        items = merge_items(items, more)
                        error = None
                    except Exception as exc:
                        error = str(exc)
                        logger.warning("[agenda] capture repair failed: %s", exc)

        missing = missing_segments(segments, items)
        if not kind:
            kind = "schedule" if (items or segments) else "chat"
        visible = [item for item in items if item.title and not item.skipped]
        logger.info(
            "[agenda] capture: %s 字 -> %s 段 / %s 条（漏 %s）",
            len(text),
            len(segments),
            len(visible),
            [seg.sid for seg in missing],
        )
        return CaptureResult(
            kind=kind, items=visible, segments=segments, missing=missing, error=error
        )

    def _capture_provider(self) -> str:
        """抽取用的提供商 ID；想用更聪明的模型时填 capture_provider_id。"""
        configured = str(self._conf("capture_provider_id", "") or "").strip()
        if configured:
            return configured
        return str(self._conf("provider_id", "") or "").strip()

    async def _draft_for(
        self,
        chat_key: str,
        text: str,
        result: CaptureResult,
        pending: dict | None,
    ) -> str:
        """Turn a capture result into a stored draft and its confirmation text."""
        assert self.store is not None
        dated = [item for item in result.items if item.date]
        undated = [item for item in result.items if not item.date]

        if not dated:
            if undated:
                return (
                    f"我听到「{undated[0].title}」，但没听出是哪天。"
                    "再说一句带日期的话就行，比如「周五 交作业」。"
                )
            return render_draft(items_payload([], raw=text, missing=result.missing))

        if pending:
            # 同一会话只保留最新草稿，避免"改口"之后越积越多。
            self.store.drop_pending(int(pending["id"]))
            # 新消息顶掉补拉草稿时，把那条队列项标成跳过，别让队列卡住。
            self._skip_asked_catchup(chat_key)

        payload = items_payload(
            dated, raw=text, kind=result.kind or "schedule", missing=result.missing
        )
        if undated:
            # 没日期的条目存不进云端，但要在回执里点名，别让用户以为记下了。
            payload["missing"] = list(payload["missing"]) + [
                f"{item.title}（没听出日期）" for item in undated
            ]
        self.store.add_pending(chat_key, text, json.dumps(payload, ensure_ascii=False))
        return render_draft(payload)

    async def _retry_pending(self, chat_key: str, pending: dict) -> str:
        """Owner said 重试: re-run capture on the original text."""
        assert self.store is not None
        try:
            payload = json.loads(pending["payload"])
        except (TypeError, ValueError):
            payload = {}
        text = str(payload.get("raw") or pending["raw_text"] or "").strip()
        self.store.drop_pending(int(pending["id"]))
        if not text:
            return "这条原文没存下来，麻烦重新发一次。"
        result = await self._capture(text)
        if result.error:
            self.store.add_pending(
                chat_key,
                text,
                json.dumps(
                    items_payload([], raw=text, missing=result.missing),
                    ensure_ascii=False,
                ),
            )
            return "还是没解析出来，可能是模型这会儿不稳。过一会儿再回「重试」也行。"
        if not result.items and not result.missing:
            return "再看还是不像日程。要是确实要记，带个时间重发一句？"
        return await self._draft_for(chat_key, text, result, None)

    async def _confirm_pending(self, pending: dict, picks: list[int] | None) -> str:
        """Write the stored draft into the cloud task table.

        Args:
            pending: The draft row.
            picks: 1-based indexes to save; None means all of them.
        """
        assert self.store is not None
        try:
            payload = json.loads(pending["payload"])
        except (TypeError, ValueError):
            payload = {}
        items = payload_items(payload)
        if not items:
            self.store.drop_pending(int(pending["id"]))
            return "这条草稿里没有能存的条目，先清掉了。"

        writer = self._writer()
        if writer is None:
            return (
                "云端还没配好（cloud_env_id / cloud_api_key / owner_id），"
                "这条草稿先留着，配好后回我一句「1」。"
            )

        chosen = picks or list(range(1, len(items) + 1))
        chosen = [index for index in chosen if 1 <= index <= len(items)]
        saved: list[dict] = []
        duplicates: list[dict] = []
        retry_items: list[dict] = []
        for index in chosen:
            item = items[index - 1]
            one = {
                "title": item.get("title") or "",
                "date": item.get("date"),
                "time": item.get("time"),
                "kind": item.get("kind") or "task",
            }
            if not one["date"]:
                retry_items.append(one)
                continue
            try:
                result = await asyncio.to_thread(writer.write, one)
            except (WriterError, ValueError) as error:
                logger.warning("[agenda] write failed: %s", error)
                retry_items.append(one)
                continue
            (duplicates if result.get("duplicate") else saved).append(result)

        self.store.drop_pending(int(pending["id"]))
        if retry_items:
            # 没写成的留在草稿里，用户回「1」就能重试，不用重说一遍。
            self.store.add_pending(
                str(pending["chat_key"]),
                str(pending["raw_text"]),
                json.dumps(
                    {
                        "v": 2,
                        "kind": payload.get("kind", "schedule"),
                        "raw": payload.get("raw", ""),
                        "items": retry_items,
                    },
                    ensure_ascii=False,
                ),
            )
        return self._write_report(saved, duplicates, retry_items, len(items), len(chosen))

    def _write_report(
        self,
        saved: list[dict],
        duplicates: list[dict],
        retry_items: list[dict],
        total: int,
        chosen: int,
    ) -> str:
        """Render the result of a cloud write round."""
        lines: list[str] = []
        if saved:
            lines.append(f"已写进日程 ✅ {len(saved)} 条")
            lines.extend(self._one_liner(row) for row in saved)
        if duplicates:
            lines.append(f"（{len(duplicates)} 条站点里已经有，没重复添加）")
        if retry_items:
            lines.append(f"（{len(retry_items)} 条没写成，草稿还在，回「1」可以重试）")
            lines.extend(self._one_liner(row, prefix="· 待重试 ") for row in retry_items)
        if not lines:
            lines.append("这次没写成，稍后回「1」再试一次。")
        if total > chosen:
            lines.append(f"（另有 {total - chosen} 条这次没选，没存）")
        return "\n".join(lines)

    def _one_liner(self, row: dict, prefix: str = "· ") -> str:
        """One ``date time title`` line for a written task."""
        when = f"{row.get('date') or ''} {row.get('time') or ''}".strip()
        return f"{prefix}{when} {row.get('title') or ''}".strip()

    def _writer(self) -> CloudWriter | None:
        """Build a writer from config, or None when the cloud is unconfigured."""
        env_id = str(self._conf("cloud_env_id", "") or "").strip()
        api_key = str(self._conf("cloud_api_key", "") or "").strip()
        owner_id = str(self._conf("owner_id", "") or "").strip()
        if not (env_id and api_key and owner_id):
            return None
        return CloudWriter(env_id, api_key, owner_id)

    def _reader(self) -> CloudReader | None:
        """Build a read-only cloud client, or None when unconfigured."""
        env_id = str(self._conf("cloud_env_id", "") or "").strip()
        api_key = str(self._conf("cloud_api_key", "") or "").strip()
        owner_id = str(self._conf("owner_id", "") or "").strip()
        if not (env_id and api_key and owner_id):
            return None
        return CloudReader(env_id, api_key, owner_id)

    # ------------------------------------------------------------ 开机补拉

    def _remember_private(self, chat_key: str, event: AstrMessageEvent) -> None:
        """Record the private chat and its newest message time as the watermark.

        Args:
            chat_key: The chat's unified message origin.
            event: The message that just arrived.
        """
        assert self.store is not None
        try:
            ts = int(event.message_obj.timestamp or 0)
        except Exception:
            ts = 0
        if not chat_key or ts <= 0:
            return
        self.store.set_state("private_chat_key", chat_key)
        seen = int(self.store.get_state("private_seen_ts", "0") or 0)
        if ts > seen:
            self.store.set_state("private_seen_ts", str(ts))

    def _skip_asked_catchup(self, chat_key: str) -> None:
        """Mark the catch-up item being asked as skipped (a new draft replaced it)."""
        assert self.store is not None
        asked = self.store.asked_catchup(chat_key)
        if asked is not None:
            self.store.mark_catchup(int(asked["id"]), "skipped")

    def _advance_catchup(self, chat_key: str, status: str) -> str:
        """Close the current catch-up item and return the next confirm prompt.

        Args:
            chat_key: Private chat the queue belongs to.
            status: ``done`` or ``skipped`` for the item just answered.

        Returns:
            The next draft prompt, or ``""`` when the queue is empty.
        """
        assert self.store is not None
        asked = self.store.asked_catchup(chat_key)
        if asked is not None:
            self.store.mark_catchup(int(asked["id"]), status)
        row = self.store.next_catchup(chat_key)
        if row is None:
            return ""
        payload = json.loads(row["payload"])
        self.store.add_pending(chat_key, row["raw_text"], row["payload"])
        self.store.mark_catchup(int(row["id"]), "asked")
        remaining = self.store.catchup_count(chat_key)
        tail = (
            f"（开机补拉，还剩 {remaining} 条）"
            if remaining
            else "（开机补拉，这是最后一条）"
        )
        return f"{render_draft(payload)}\n{tail}"

    def _admin_ids(self) -> list[str]:
        """The AstrBot admin ids, i.e. the only humans allowed to use the bot."""
        try:
            return [str(x) for x in (self.context.get_config().get("admins_id") or [])]
        except Exception:
            return []

    def _platform(self):
        """The aiocqhttp adapter instance, or None before it is registered."""
        try:
            return self.context.get_platform(filter.PlatformAdapterType.AIOCQHTTP)
        except Exception:
            return None

    def _private_chat_key(self) -> str:
        """Best-known private-chat origin, falling back to the admin id."""
        assert self.store is not None
        key = self.store.get_state("private_chat_key")
        if key:
            return key
        admins = self._admin_ids()
        platform = self._platform()
        if not admins or platform is None:
            return ""
        try:
            platform_id = platform.meta().id
        except Exception:
            return ""
        return f"{platform_id}:FriendMessage:{admins[0]}"

    async def _onebot_ready(self) -> bool:
        """True once the OneBot client answers (SnowLuma injected and connected)."""
        platform = self._platform()
        if platform is None:
            return False
        try:
            client = platform.get_client()
            if client is None:
                return False
            await client.call_action("get_login_info")
            return True
        except Exception:
            return False

    async def _catchup_loop(self) -> None:
        """Run the catch-up once per process start, after OneBot is reachable."""
        if not bool(self._conf("catchup_enabled", True)):
            return
        for _ in range(30):
            await asyncio.sleep(10)
            if self.store is None:
                continue
            chat_key = self._private_chat_key()
            if not chat_key:
                continue
            try:
                if not await self._onebot_ready():
                    continue
                await self._run_catchup(chat_key)
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[agenda] catch-up failed, will retry")
                await asyncio.sleep(20)
        logger.warning("[agenda] catch-up skipped: OneBot never became reachable")

    async def _run_catchup(self, chat_key: str) -> None:
        """Fetch the friend history and queue the owner's missed schedules.

        Args:
            chat_key: Private chat with the owner.
        """
        assert self.store is not None
        owner = chat_key.rsplit(":", 1)[-1].strip()
        if not owner.isdigit():
            return
        since = int(self.store.get_state("private_seen_ts", "0") or 0)
        if since <= 0:
            # 第一次装补拉：没有基线，就从现在开始记，别把旧聊天全问一遍。
            self.store.set_state("private_seen_ts", str(now_ts()))
            return

        history = await self._fetch_history(owner)
        batch = select_candidates(
            history,
            owner_id=owner,
            since_ts=since,
            now=now_ts(),
            max_age_days=int(self._conf("catchup_max_age_days", 7)),
            min_len=int(self._conf("min_text_len", 4)),
            limit=int(self._conf("catchup_max_items", 20)),
        )
        queued = 0
        for missed in batch.fresh:
            if self.store.has_catchup(missed["message_id"]):
                continue
            result = await self._capture(missed["text"])
            dated = [item for item in result.items if item.date]
            if not dated:
                continue
            payload = items_payload(
                dated, raw=missed["text"], kind=result.kind or "schedule", missing=result.missing
            )
            if self.store.enqueue_catchup(
                chat_key=chat_key,
                message_id=missed["message_id"],
                ts=missed["ts"],
                raw_text=missed["text"],
                payload=json.dumps(payload, ensure_ascii=False),
            ):
                queued += 1

        # 即使一条都没排进队列，水位也要前移，否则每次开机都会重复扫同一段。
        if batch.newest_ts > since:
            self.store.set_state("private_seen_ts", str(batch.newest_ts))
        logger.info(
            "[agenda] catch-up: fresh=%s queued=%s old=%s dropped=%s",
            len(batch.fresh),
            queued,
            batch.stale,
            batch.dropped,
        )
        # 已有未答完的草稿：补拉队列留着，等那条处理完会自动接着问。
        total = self.store.catchup_count(chat_key)
        if total == 0 or self.store.latest_pending(chat_key) is not None:
            return

        head = f"🔄 开机补拉：关机期间有 {total} 条像日程，我一条条跟你确认。"
        if batch.stale:
            age = self._conf("catchup_max_age_days", 7)
            head += f"\n（另有 {batch.stale} 条超过 {age} 天，太旧就不逐条问了）"
        prompt = self._advance_catchup(chat_key, "done")
        if prompt:
            await self._send_text(chat_key, f"{head}\n\n{prompt}")

    async def _fetch_history(self, owner: str) -> list[dict]:
        """One page of the friend history with the owner.

        Args:
            owner: The owner's QQ id as a string.

        Returns:
            Raw OneBot message dicts; empty when nothing could be fetched.
        """
        platform = self._platform()
        if platform is None:
            return []
        data = await platform.get_client().call_action(
            "get_friend_msg_history",
            user_id=int(owner),
            count=int(self._conf("catchup_history_count", 200)),
        )
        if isinstance(data, dict) and isinstance(data.get("messages"), list):
            return [m for m in data["messages"] if isinstance(m, dict)]
        return []

    async def _send_text(self, chat_key: str, text: str) -> bool:
        """Send a proactive message to one chat origin."""
        try:
            return bool(
                await self.context.send_message(chat_key, MessageChain().message(text))
            )
        except Exception:
            logger.exception("[agenda] send to %s failed", chat_key)
            return False

    # ------------------------------------------------------------ 每日简报

    def _apply_daily_intent(self, intent: DailyIntent) -> str:
        """Persist a daily-brief request and return the confirmation text."""
        assert self.store is not None
        if intent.action == "off":
            self.store.set_state("daily_push_time", "")
            return "好，每日简报关掉了。"

        if intent.action == "show":
            target = self.store.get_state("daily_push_time")
            if not target:
                return "每日简报还没开。想开就说「每天 9 点提醒我」。"
            return f"每天 {target} 给你发一次任务简报。要关掉就说「取消每天提醒」。"

        if intent.action == "set" and intent.time:
            self.store.set_state("daily_push_time", intent.time)
            self.store.set_state("daily_push_last", "")
            return (
                f"好，每天 {intent.time} 给你发一次任务简报。\n"
                "（那天电脑没开的话，开机后会补发一次）"
            )

        return "几点？说「每天 9 点提醒我」就行。"

    async def _daily_push_loop(self) -> None:
        """Send the configured daily task brief to the owner's private chat."""
        while True:
            try:
                await asyncio.sleep(30)
                if self.store is None:
                    continue
                target = self.store.get_state("daily_push_time")
                if not target:
                    continue
                chat_key = self.store.get_state("private_chat_key")
                if not chat_key:
                    continue
                now = datetime.now(CST)
                if not push_due(now, target, self.store.get_state("daily_push_last")):
                    continue
                reader = self._reader()
                if reader is None:
                    continue
                overview = await asyncio.to_thread(
                    reader.overview, days=int(self._conf("daily_push_days", 7))
                )
                title = f"🗓 每日简报（{now:%m-%d} 周{'一二三四五六日'[now.weekday()]}）"
                if await self._send_text(chat_key, format_overview(overview, title=title)):
                    self.store.set_state("daily_push_last", now.strftime("%Y-%m-%d"))
                    logger.info("[agenda] daily brief sent at %s", now.strftime("%H:%M"))
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[agenda] daily push error")

    # ------------------------------------------------------------ 到点追问完成

    async def _followup_loop(self) -> None:
        """到点后问一句"完成了吗"，确认后把任务标成已完成。

        只问一次：``(task_id, day)`` 记进 ``followups`` 表，重复触发不会再问。
        正在确认草稿、或者上一批还没回答时先不打扰，免得消息叠在一起。
        """
        while True:
            try:
                await asyncio.sleep(max(30, int(self._conf("followup_check_sec", 300))))
                if not bool(self._conf("followup_enabled", True)):
                    continue
                if self.store is None:
                    continue
                chat_key = self.store.get_state("private_chat_key")
                if not chat_key:
                    continue
                if self.store.latest_pending(chat_key) is not None:
                    continue
                if self.store.open_followups(OPEN_TTL_HOURS):
                    continue
                reader = self._reader()
                if reader is None:
                    continue
                now = datetime.now(CST)
                overview = await asyncio.to_thread(reader.overview, days=0)
                rows = due_rows(
                    overview.today_items + overview.overdue,
                    now=now,
                    grace_min=int(self._conf("followup_grace_min", 15)),
                    limit=int(self._conf("followup_max_items", 6)),
                )
                claimed = self.store.claim_followups(rows)
                if not claimed:
                    continue
                if not await self._send_text(chat_key, render_question(claimed, now=now)):
                    # 没发出去就别占坑，下一轮重试。
                    for row in claimed:
                        self.store.drop_followup(str(row["id"]), str(row["date"]))
                    continue
                logger.info("[agenda] follow-up asked: %s 项", len(claimed))
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[agenda] follow-up loop error")

    async def _apply_followup(self, picks: list[int], rows: list[dict]) -> str:
        """处理对追问的回复：选中的标完成，``[]`` 表示这些都没做。

        Args:
            picks: 1-based 序号；空列表表示"都没做"。
            rows: ``store.open_followups()`` 的行，含 ``task_id`` / ``day`` / ``title``。
        """
        assert self.store is not None
        if not picks:
            self.store.resolve_followups([int(row["id"]) for row in rows], "skipped")
            return "好，这几项就不标完成了；任务还在，做完去站点勾一下也一样。"

        chosen = [rows[index - 1] for index in picks if 1 <= index <= len(rows)]
        writer = self._writer()
        if writer is None:
            return "云端还没配好（cloud_env_id / cloud_api_key / owner_id），先没法标记完成。"

        done: list[dict] = []
        failed: list[dict] = []
        for row in chosen:
            try:
                await asyncio.to_thread(
                    writer.complete, str(row["task_id"]), str(row["day"])
                )
            except (WriterError, ValueError) as error:
                logger.warning("[agenda] complete failed: %s", error)
                failed.append(row)
                continue
            except Exception:
                logger.exception("[agenda] complete crashed")
                failed.append(row)
                continue
            done.append(row)

        self.store.resolve_followups([int(row["id"]) for row in done], "done")
        lines = [f"✅ 已标记完成 {len(done)} 项"]
        for row in done:
            lines.append(f"· {row['title']}（{row['day']} {row['clock']}）")
        if failed:
            lines.append(f"（{len(failed)} 项没标上，回「完成」我再试一次）")
        return "\n".join(lines)

    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE)
    async def on_group_message(self, event: AstrMessageEvent) -> None:
        """Apply the per-group policy: record silently, chat, or stay mute.

        The handler is deliberately the only group entry point. Because a
        matching handler marks the event as woken, it must also suppress the
        default LLM call for every group that is not a chat group.

        Args:
            event: The incoming group message.
        """
        if self.store is None:
            self._ensure_started()
        if self.store is None:
            return

        group_id = str(event.get_group_id() or "").strip()
        if not group_id:
            return

        # Never react to the bot's own messages.
        if str(event.get_sender_id()) == str(event.get_self_id()):
            event.should_call_llm(False)
            return

        if is_watch(group_id):
            text = (event.message_str or "").strip()
            if text and is_worth_storing(text, int(self._conf("min_text_len", 4))):
                message_id = str(event.message_obj.message_id or "")
                if message_id:
                    self.store.add_message(
                        message_id=message_id,
                        group_id=group_id,
                        sender_id=str(event.get_sender_id()),
                        sender_name=event.get_sender_name() or "",
                        ts=int(event.message_obj.timestamp or now_ts()),
                        text=text,
                    )
            # Hard silence: no LLM call, no reply, no further propagation.
            event.should_call_llm(False)
            event.stop_event()
            return

        if is_chat(group_id):
            # Only answer when the bot was addressed (@ or wake prefix).
            if not getattr(event, "is_at_or_wake_command", False):
                event.should_call_llm(False)
            return

        # Unconfigured group: say nothing at all.
        event.should_call_llm(False)

    # ------------------------------------------------------------------ 抽取

    async def _extract_loop(self) -> None:
        """Poll for a full batch or an elapsed interval, then extract."""
        interval = max(15, int(self._conf("extract_interval_sec", 60)))
        batch = max(5, int(self._conf("extract_batch_size", 40)))
        while True:
            try:
                await asyncio.sleep(15)
                if self.store is None:
                    continue
                pending = len(self.store.pending_messages(batch))
                elapsed = asyncio.get_running_loop().time() - self._last_extract
                if pending == 0:
                    continue
                if pending >= batch or elapsed >= interval:
                    await self._extract_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[agenda] extract loop error")

    async def _extract_once(self) -> None:
        """Claim one batch, ask the model and persist the resulting events."""
        assert self.store is not None
        if not self._budget_left():
            logger.warning("[agenda] daily token budget exhausted, skipping extraction")
            return

        batch = max(5, int(self._conf("extract_batch_size", 40)))
        self._batch_seq += 1
        batch_id = self._batch_seq
        rows = self.store.claim_batch(batch_id, batch)
        if not rows:
            return
        self._last_extract = asyncio.get_running_loop().time()

        prompt = build_prompt(
            [dict(r) for r in rows],
            now=datetime.now(CST),
            max_chars=int(self._conf("extract_max_chars", 200)),
        )
        try:
            reply = await self._ask_model(prompt)
            drafts = parse_events(reply)
        except Exception as exc:
            logger.warning("[agenda] extraction failed, releasing batch: %s", exc)
            self.store.release_batch(batch_id)
            return

        min_conf = float(self._conf("min_confidence", 0.6))
        created = 0
        for draft in drafts:
            if self._save_draft(draft, rows, min_conf):
                created += 1
        logger.info(
            "[agenda] batch %s: %s messages -> %s events (%s new)",
            batch_id,
            len(rows),
            len(drafts),
            created,
        )

    async def _ask_model(
        self,
        prompt: str,
        system: str = SYSTEM_PROMPT,
        provider_id: str | None = None,
    ) -> str:
        """Send one prompt to the configured provider.

        Args:
            prompt: The user prompt.
            system: System prompt; defaults to the group batch extractor.
            provider_id: Override the provider for this call (capture may want a
                stronger model than chat).

        Returns:
            The raw model text.

        Raises:
            RuntimeError: When no provider id can be resolved.
        """
        provider_id = provider_id or self._resolve_provider_id()
        if not provider_id:
            raise RuntimeError(
                "no provider id: set plugin provider_id or a default chat provider"
            )
        resp = await self.context.llm_generate(
            chat_provider_id=provider_id,
            prompt=prompt,
            system_prompt=system,
        )
        text = getattr(resp, "completion_text", "") or ""
        self._charge_budget(len(prompt) + len(text))
        return text

    def _resolve_provider_id(self) -> str:
        """Resolve the provider used for extraction."""
        configured = str(self._conf("provider_id", "") or "").strip()
        if configured:
            return configured
        try:
            cfg = self.context.get_config()
            return str(cfg.get("provider_settings", {}).get("default_provider_id", ""))
        except Exception:
            return ""

    def _save_draft(
        self,
        draft: DraftEvent,
        rows: list,
        min_conf: float,
    ) -> bool:
        """Persist one draft, merging it into an existing similar event.

        Args:
            draft: Parsed event candidate.
            rows: The message rows the batch was built from.
            min_conf: Confidence below which the event stays pending.

        Returns:
            True when a new event row was created.
        """
        assert self.store is not None
        if draft.start_at is None:
            # Without a concrete time it cannot be reminded; keep it out of the table.
            logger.debug("[agenda] drop time-less draft: %s", draft.title)
            return False

        title_norm = normalize_title(draft.title)
        if not title_norm:
            return False

        existing = self.store.find_similar_event(title_norm, draft.start_at)
        if existing is not None:
            return False

        group_id = str(rows[0]["group_id"]) if rows else None
        excerpt = " / ".join(str(r["text"])[:60] for r in rows[:3])
        status = "confirmed" if draft.confidence >= min_conf else "pending"
        event_id = self.store.add_event(
            title=draft.title,
            title_norm=title_norm,
            start_at=draft.start_at,
            end_at=draft.end_at,
            all_day=draft.all_day,
            location=draft.location,
            participants=json.dumps(draft.participants, ensure_ascii=False),
            group_id=group_id,
            source_msg_ids=json.dumps(draft.source_msg_ids, ensure_ascii=False),
            raw_excerpt=excerpt,
            confidence=draft.confidence,
            status=status,
        )
        if status == "confirmed":
            self._schedule_reminders(event_id, draft)
        return True

    def _schedule_reminders(self, event_id: int, draft: DraftEvent) -> None:
        """Create the lead reminder and, for all-day items, the night-before one.

        Args:
            event_id: Newly created event id.
            draft: The event draft holding the start time.
        """
        assert self.store is not None
        if draft.start_at is None:
            return
        now = now_ts()
        lead_min = int(self._conf("remind_lead_min", 30))
        if draft.all_day:
            hour = int(self._conf("allday_remind_hour", 21))
            day = datetime.fromtimestamp(draft.start_at, CST) - timedelta(days=1)
            fire_at = int(day.replace(hour=hour, minute=0, second=0).timestamp())
            if fire_at > now:
                self.store.add_reminder(event_id, fire_at, "allday_prev")
            return
        fire_at = draft.start_at - lead_min * 60
        if fire_at > now:
            self.store.add_reminder(event_id, fire_at, f"lead{lead_min}")

    # ------------------------------------------------------------------ 提醒

    async def _reminder_loop(self) -> None:
        """Fire due reminders and the daily digest."""
        while True:
            try:
                await asyncio.sleep(20)
                if self.store is None:
                    continue
                await self._fire_due_reminders()
                await self._maybe_digest()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[agenda] reminder loop error")

    async def _fire_due_reminders(self) -> None:
        """Send every reminder whose time has come."""
        assert self.store is not None
        now = now_ts()
        for row in self.store.due_reminders(now):
            start_at = int(row["start_at"]) if row["start_at"] is not None else None
            if start_at is not None and start_at < now - 3600:
                # More than an hour late: the bot was probably offline. Do not spam.
                self.store.mark_reminder_sent(int(row["id"]), -1)
                continue
            text = self._format_reminder(row, now)
            if await self._send_to_owner(text):
                self.store.mark_reminder_sent(int(row["id"]), now)
            else:
                self.store.mark_reminder_sent(int(row["id"]), -1)

    def _format_reminder(self, row: Any, now: int) -> str:
        """Render one reminder message.

        Args:
            row: Joined reminder/event row.
            now: Current UNIX timestamp.

        Returns:
            The message text.
        """
        start_at = int(row["start_at"]) if row["start_at"] is not None else None
        if row["all_day"]:
            head = "📅 明天"
        elif start_at is None:
            head = "⏰ 提醒"
        else:
            minutes = max(0, (start_at - now) // 60)
            head = "⏰ 即将开始" if minutes <= 5 else f"⏰ {minutes} 分钟后"
        lines = [head, f"· 事项：{row['title']}", f"· 时间：{format_ts(start_at, with_year=True)}"]
        if row["location"]:
            lines.append(f"· 地点：{row['location']}")
        lines.append(f"回复「详情 {row['event_id']}」查看原文")
        return "\n".join(lines)

    async def _maybe_digest(self) -> None:
        """Send the once-a-day agenda summary when its time arrives."""
        assert self.store is not None
        target = str(self._conf("daily_digest", "08:30") or "").strip()
        if not target:
            return
        now_dt = datetime.now(CST)
        today = now_dt.strftime("%Y-%m-%d")
        if self.store.get_state("digest_date") == today:
            return
        if now_dt.strftime("%H:%M") < target:
            return
        start = int(now_dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        events = self.store.events_between(start, start + 4 * 86400)
        self.store.set_state("digest_date", today)
        if not events:
            return
        lines = [f"📋 {now_dt:%m-%d} 日程（未来 3 天 {len(events)} 项）"]
        for ev in events:
            all_day = "（全天）" if ev["all_day"] else ""
            lines.append(f"· {format_ts(ev['start_at'])} {ev['title']}{all_day}")
        await self._send_to_owner("\n".join(lines))

    async def _send_to_owner(self, text: str) -> bool:
        """Deliver a proactive message to the bound session.

        Args:
            text: Message body.

        Returns:
            True when the message was handed to the platform.
        """
        assert self.store is not None
        umo = self.store.get_state("inbox_umo")
        if not umo:
            if not self._warned_no_umo:
                logger.warning("[agenda] no inbox bound yet, run /绑定 first")
                self._warned_no_umo = True
            return False
        try:
            return bool(await self.context.send_message(umo, MessageChain().message(text)))
        except Exception:
            logger.exception("[agenda] send failed")
            return False

    # ------------------------------------------------------------------ 预算

    def _budget_left(self) -> bool:
        """Consume one unit of daily budget and report whether it may proceed."""
        assert self.store is not None
        today = datetime.now(CST).strftime("%Y-%m-%d")
        if self.store.get_state("token_date") != today:
            self.store.set_state("token_date", today)
            self.store.set_state("token_used", "0")
        used = int(self.store.get_state("token_used", "0") or 0)
        return used < int(self._conf("daily_token_budget", 300000))

    def _charge_budget(self, tokens: int) -> None:
        """Add consumed tokens to today's counter."""
        assert self.store is not None
        used = int(self.store.get_state("token_used", "0") or 0)
        self.store.set_state("token_used", str(used + max(0, tokens)))

    # ------------------------------------------------------------- 插件页面 API

    async def _fetch_groups(self) -> list[dict]:
        """Ask the OneBot side for the bot's group list.

        Returns:
            A list of ``{group_id, group_name, member_count}`` dicts, sorted by
            name. Empty when the platform is not connected yet.
        """
        try:
            platform = self.context.get_platform(filter.PlatformAdapterType.AIOCQHTTP)
        except Exception:
            platform = None
        if platform is None:
            return []
        try:
            data = await platform.get_client().call_action("get_group_list")
        except Exception as exc:
            logger.warning("[agenda] get_group_list failed: %s", exc)
            return []

        groups = []
        for item in data or []:
            if not isinstance(item, dict):
                continue
            groups.append(
                {
                    "group_id": str(item.get("group_id", "")),
                    "group_name": str(item.get("group_name", "")),
                    "member_count": int(item.get("member_count", 0) or 0),
                }
            )
        groups.sort(key=lambda item: item["group_name"])
        return groups

    async def api_groups(self):
        """Plugin view: live group list plus the current policy."""
        return json_response(
            {
                "groups": await self._fetch_groups(),
                "chat": sorted(chat_group_ids()),
                "watch": sorted(watch_group_ids()),
            }
        )

    async def api_save_groups(self):
        """Plugin view: persist the chat/watch policy without a restart."""
        payload = await request.json(default={})
        if not isinstance(payload, dict):
            return error_response("invalid payload", status_code=400)
        chat = payload.get("chat", [])
        watch = payload.get("watch", [])
        if not isinstance(chat, list) or not isinstance(watch, list):
            return error_response("chat/watch must be lists", status_code=400)

        chat_ids = sorted({str(x).strip() for x in chat if str(x).strip()})
        watch_ids = sorted(
            {str(x).strip() for x in watch if str(x).strip()} - set(chat_ids)
        )

        self.conf["chat_groups"] = [_as_number(g) for g in chat_ids]
        self.conf["watch_groups"] = [_as_number(g) for g in watch_ids]
        try:
            self.conf.save_config()
        except Exception:
            logger.exception("[agenda] failed to save plugin config")
            return error_response("save failed", status_code=500)

        set_policy(chat_ids, watch_ids)
        logger.info("[agenda] policy updated, chat=%s watch=%s", chat_ids, watch_ids)
        return json_response({"saved": True, "chat": chat_ids, "watch": watch_ids})

    # ------------------------------------------------------------------ 指令

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("绑定")
    async def cmd_bind(self, event: AstrMessageEvent):
        """把当前会话设为提醒投递目标。"""
        assert self.store is not None
        self.store.set_state("inbox_umo", event.unified_msg_origin)
        yield event.plain_result(f"已绑定提醒投递到当前会话：{event.unified_msg_origin}")

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("任务")
    async def cmd_tasks(self, event: AstrMessageEvent):
        """查看云端所有未完成任务（逾期 / 今天 / 未来几天）。"""
        yield event.plain_result(await self._tasks_reply())

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("日程")
    async def cmd_agenda(self, event: AstrMessageEvent):
        """同 /任务：读云端，而不是本地群聊抽取结果。"""
        yield event.plain_result(await self._tasks_reply())

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("提醒")
    async def cmd_reminder_settings(self, event: AstrMessageEvent):
        """查看云端当前的提醒时间设置。"""
        reader = self._reader()
        if reader is None:
            yield event.plain_result("云端还没配好（cloud_env_id / cloud_api_key / owner_id）。")
            return
        try:
            settings = await asyncio.to_thread(reader.settings_row)
        except ReaderError as error:
            logger.warning("[agenda] reminder settings failed: %s", error)
            yield event.plain_result(f"读取提醒设置失败：{error}")
            return
        except Exception:
            logger.exception("[agenda] reminder settings crashed")
            yield event.plain_result("读取提醒设置时出错了，稍后再试。")
            return
        yield event.plain_result(format_settings(settings))

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("每日提醒")
    async def cmd_daily_push(self, event: AstrMessageEvent):
        """查看或设置每日简报：``/每日提醒 09:00``、``/每日提醒 关``。"""
        rest = (event.message_str or "").strip().split("每日提醒", 1)[-1].strip()
        if rest in {"关", "关闭", "取消", "停", "off", "OFF"}:
            intent = DailyIntent("off")
        else:
            clock = parse_clock(rest) if rest else None
            intent = DailyIntent("set", clock) if clock else DailyIntent("show")
        yield event.plain_result(self._apply_daily_intent(intent))

    async def _tasks_reply(self) -> str:
        """Formatted cloud task overview, used by /任务 and /日程."""
        reader = self._reader()
        if reader is None:
            return "云端还没配好（cloud_env_id / cloud_api_key / owner_id）。"
        try:
            overview = await asyncio.to_thread(
                reader.overview, days=int(self._conf("list_days", 7))
            )
        except ReaderError as error:
            logger.warning("[agenda] task list failed: %s", error)
            return f"读取失败：{error}。稍后再试一次。"
        except Exception:
            logger.exception("[agenda] task list crashed")
            return "读取任务时出错了，稍后再试。"
        return format_overview(overview)

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("详情")
    async def cmd_detail(self, event: AstrMessageEvent, event_id: int = 0):
        """查看某条日程的来源原文。"""
        assert self.store is not None
        row = self.store.get_event(event_id)
        if row is None:
            yield event.plain_result(f"没有 id 为 {event_id} 的日程。")
            return
        lines = [
            f"#{row['id']} {row['title']}",
            f"时间：{format_ts(row['start_at'], with_year=True)}",
            f"状态：{row['status']}  置信度：{row['confidence']:.2f}",
        ]
        if row["location"]:
            lines.append(f"地点：{row['location']}")
        if row["raw_excerpt"]:
            lines.append(f"原文：{row['raw_excerpt']}")
        if row["source_msg_ids"]:
            lines.append(f"消息 id：{row['source_msg_ids']}")
        yield event.plain_result("\n".join(lines))

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("完成")
    async def cmd_done(self, event: AstrMessageEvent, event_id: int = 0):
        """标记日程为已完成。"""
        assert self.store is not None
        ok = self.store.set_event_status(event_id, "done")
        yield event.plain_result("已标记完成。" if ok else "没有找到该日程。")

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("取消")
    async def cmd_cancel(self, event: AstrMessageEvent, event_id: int = 0):
        """取消日程及其提醒。"""
        assert self.store is not None
        ok = self.store.set_event_status(event_id, "cancelled")
        yield event.plain_result("已取消。" if ok else "没有找到该日程。")

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("待确认")
    async def cmd_pending(self, event: AstrMessageEvent):
        """列出置信度不足、尚未提醒的日程。"""
        assert self.store is not None
        rows = self.store.pending_events()
        if not rows:
            yield event.plain_result("没有待确认的日程。")
            return
        lines = [f"❓ 待确认 {len(rows)} 项（确认后才会提醒）"]
        for row in rows:
            lines.append(
                f"· #{row['id']} {format_ts(row['start_at'])} {row['title']}"
                f"（{row['confidence']:.2f}）"
            )
        yield event.plain_result("\n".join(lines))

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("状态")
    async def cmd_status(self, event: AstrMessageEvent):
        """查看运行状态、用量与白名单。"""
        assert self.store is not None
        watch = sorted(watch_group_ids())
        chat = sorted(chat_group_ids())
        used = self.store.get_state("token_used", "0")
        budget = int(self._conf("daily_token_budget", 300000))
        umo = self.store.get_state("inbox_umo") or "未绑定"
        yield event.plain_result(
            "\n".join(
                [
                    "⚙️ agenda 状态",
                    f"小号：{event.get_self_id()}",
                    f"静默群：{', '.join(str(g) for g in watch) or '未配置'}",
                    f"陪聊群：{', '.join(str(g) for g in chat) or '未配置'}",
                    f"今日 token：{used}/{budget}",
                    f"提醒投递：{umo}",
                ]
            )
        )
