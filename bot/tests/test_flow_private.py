"""End-to-end private-chat flow against the real AstrBot runtime.

Unlike ``test_capture.py`` this drives the actual plugin handler
(``Main.on_private_message``) with a fake event, a fake model and a fake cloud
writer, so the draft text, the confirm gate and the "chat falls through"
behaviour are all exercised. Skipped automatically when AstrBot is absent.
"""

import asyncio
import importlib
import json
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

FIXTURE = Path(__file__).with_name("fixtures") / "training_notice.txt"
NOTICE = FIXTURE.read_text(encoding="utf-8")

# AstrBot 在 import 时就会建 ASTRBOT_ROOT/data/temp，所以必须在导入前指好目录。
_BASE = Path(os.environ.get("AGENDA_TEST_DIR") or Path(tempfile.gettempdir()) / "agenda-itest")
try:
    _BASE.mkdir(parents=True, exist_ok=True)
except OSError:  # 目录不可写时让下面的 import 自己失败并 skip
    pass
os.environ.setdefault("ASTRBOT_ROOT", str(_BASE))

ASTRBOT_AVAILABLE = True
try:  # pragma: no cover - depends on the host
    import astrbot.api.event  # noqa: F401
except Exception:  # pragma: no cover
    ASTRBOT_AVAILABLE = False

REPLY_ONE = json.dumps(
    {
        "kind": "schedule",
        "items": [
            {
                "seg": "S1",
                "title": "党校培训：习近平党建思想专题报告",
                "date": "2026-11-17",
                "time": "16:30",
                "kind": "event",
                "confidence": 0.9,
            }
        ],
    },
    ensure_ascii=False,
)

REPLY_REST = json.dumps(
    {
        "kind": "schedule",
        "items": [
            {"seg": "S2", "title": "五中全会精神专题报告", "date": "2026-12-01",
             "time": "16:30", "kind": "event", "confidence": 0.9},
            {"seg": "S3", "title": "学习党章党规", "date": "2026-11-20",
             "time": "16:30", "kind": "event", "confidence": 0.9},
            {"seg": "S4", "title": "世界社会主义运动", "date": "2026-11-25",
             "time": "16:30", "kind": "event", "confidence": 0.9},
        ]
    },
    ensure_ascii=False,
)


class FakeWriter:
    """Records what would have been written to CloudBase."""

    def __init__(self) -> None:
        self.writes: list[dict] = []
        self.completed: list[tuple[str, str]] = []
        self.fail_ids: set[str] = set()

    def write(self, payload: dict) -> dict:
        self.writes.append(dict(payload))
        return {
            "id": f"id-{len(self.writes)}",
            "date": payload["date"],
            "time": payload.get("time") or "20:00",
            "title": payload["title"],
            "duplicate": False,
        }

    def complete(self, task_id: str, day: str) -> dict:
        if task_id in self.fail_ids:
            raise RuntimeError("boom")
        self.completed.append((task_id, day))
        return {"task_id": task_id, "date": day}


class FakeModel:
    """Answers the full prompt with one item and the repair prompt with the rest."""

    def __init__(self, router=None) -> None:
        self.calls: list[str] = []
        self.router = router or self.default_router

    def default_router(self, prompt: str) -> str:
        if "[S2]" in prompt and "[S1]" not in prompt:
            return REPLY_REST
        return REPLY_ONE

    async def __call__(self, prompt: str, system=None, provider_id=None) -> str:
        self.calls.append(prompt)
        return self.router(prompt)


class FakeEvent:
    def __init__(self, text: str, sender: str = "10001") -> None:
        self.message_str = text
        self.sender = sender
        self.unified_msg_origin = "qq:FriendMessage:10001"
        self.message_obj = SimpleNamespace(timestamp=1794800000, message_id="m-1")
        self.stopped = False
        self.llm_allowed = True

    def get_sender_id(self) -> str:
        return self.sender

    def get_self_id(self) -> str:
        return "999"

    def should_call_llm(self, value: bool) -> None:
        self.llm_allowed = value

    def stop_event(self) -> None:
        self.stopped = True

    def plain_result(self, text: str):
        return SimpleNamespace(text=text)


class FakeContext:
    def __init__(self) -> None:
        self.config = {"admins_id": ["10001"]}

    def register_web_api(self, *args, **kwargs) -> None:
        return None

    def get_config(self) -> dict:
        return self.config


@unittest.skipUnless(ASTRBOT_AVAILABLE, "needs the AstrBot runtime")
class PrivateFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        # 用固定的临时根目录：Windows 沙箱下 mkdtemp 产生的新目录有时不可写，
        # 而父目录存在时 python 的子目录是可写的。
        base = Path(os.environ.get("AGENDA_TEST_DIR") or Path(tempfile.gettempdir()) / "agenda-itest")
        base.mkdir(parents=True, exist_ok=True)
        self.work = base / f"case-{uuid.uuid4().hex[:8]}"
        self.work.mkdir(exist_ok=True)
        os.environ["ASTRBOT_ROOT"] = str(base)
        self.main = importlib.import_module("astrbot_plugin_agenda.main")
        self.model = FakeModel()
        self.writer = FakeWriter()
        self.plugin = self.main.Main(FakeContext())
        self.plugin.store = self.main.Store(self.work / "agenda.db")
        self.plugin._ask_model = self.model
        self.plugin._writer = lambda: self.writer

    def tearDown(self) -> None:
        self.plugin.store.close()
        shutil.rmtree(self.work, ignore_errors=True)

    def send(self, text: str) -> tuple[FakeEvent, list]:
        event = FakeEvent(text)

        async def run():
            return [chunk async for chunk in self.plugin.on_private_message(event)]

        return event, asyncio.run(run())

    def test_notice_becomes_four_items_and_saves_all(self):
        event, out = self.send(NOTICE)
        self.assertTrue(event.stopped)
        self.assertFalse(event.llm_allowed)
        self.assertEqual(len(out), 1)
        draft = out[0].text
        self.assertIn("一共 4 条", draft)
        self.assertIn("2026-12-01", draft)
        self.assertIn("2026-11-25", draft)

        _, out2 = self.send("1")
        self.assertEqual(len(self.writer.writes), 4)
        dates = sorted(row["date"] for row in self.writer.writes)
        self.assertEqual(
            dates, ["2026-11-17", "2026-11-20", "2026-11-25", "2026-12-01"]
        )
        self.assertIn("已写进日程", out2[0].text)
        self.assertIsNone(self.plugin.store.latest_pending("qq:FriendMessage:10001"))

    def test_partial_selection_saves_only_the_picked_ones(self):
        self.send(NOTICE)
        _, out = self.send("1 3")
        self.assertEqual(len(self.writer.writes), 2)
        self.assertEqual(
            [row["title"] for row in self.writer.writes],
            ["党校培训：习近平党建思想专题报告", "学习党章党规"],
        )
        self.assertIn("2 条这次没选", out[0].text)

    def test_chat_falls_through_to_normal_reply(self):
        self.model.router = lambda prompt: '{"kind":"chat","items":[{"seg":"S1","skip":true}]}'
        event, out = self.send("今天好累啊，晚上不想动")
        self.assertEqual(out, [])
        self.assertFalse(event.stopped)
        self.assertTrue(event.llm_allowed)

    def test_task_without_date_asks_for_one(self):
        self.model.router = lambda prompt: (
            '{"kind":"schedule","items":[{"seg":"extra","title":"给老师发邮件",'
            '"date":null,"time":null,"kind":"task"}]}'
        )
        event, out = self.send("记得给老师发邮件")
        self.assertTrue(event.stopped)
        self.assertIn("没听出是哪天", out[0].text)
        self.assertEqual(self.writer.writes, [])

    def test_cancel_drops_the_draft(self):
        self.send(NOTICE)
        self.send("2")
        self.assertIsNone(self.plugin.store.latest_pending("qq:FriendMessage:10001"))
        self.assertEqual(self.writer.writes, [])

    def ask(self, rows):
        """Pretend the follow-up loop already asked about these tasks."""
        return self.plugin.store.claim_followups(rows)

    def test_done_reply_marks_every_asked_task(self):
        self.ask(
            [
                {"id": "t1", "title": "交作业", "date": "2026-11-16", "clock": "09:00"},
                {"id": "t2", "title": "党校培训", "date": "2026-11-16", "clock": "16:30"},
            ]
        )
        event, out = self.send("完成")
        self.assertTrue(event.stopped)
        self.assertEqual(
            self.writer.completed, [("t1", "2026-11-16"), ("t2", "2026-11-16")]
        )
        self.assertIn("已标记完成 2 项", out[0].text)
        self.assertEqual(self.plugin.store.open_followups(), [])

    def test_number_reply_marks_only_that_task(self):
        self.ask(
            [
                {"id": "t1", "title": "交作业", "date": "2026-11-16", "clock": "09:00"},
                {"id": "t2", "title": "党校培训", "date": "2026-11-16", "clock": "16:30"},
            ]
        )
        _, out = self.send("2")
        self.assertEqual(self.writer.completed, [("t2", "2026-11-16")])
        self.assertIn("已标记完成 1 项", out[0].text)
        # 剩下那条还能再回
        self.assertEqual(len(self.plugin.store.open_followups()), 1)

    def test_not_done_reply_stops_asking(self):
        self.ask([{"id": "t1", "title": "交作业", "date": "2026-11-16", "clock": "09:00"}])
        _, out = self.send("没做")
        self.assertEqual(self.writer.completed, [])
        self.assertIn("不标完成", out[0].text)
        self.assertEqual(self.plugin.store.open_followups(), [])

    def test_failed_write_keeps_the_followup_open(self):
        self.ask([{"id": "t1", "title": "交作业", "date": "2026-11-16", "clock": "09:00"}])
        self.writer.fail_ids.add("t1")
        _, out = self.send("完成")
        self.assertIn("没标上", out[0].text)
        self.assertEqual(len(self.plugin.store.open_followups()), 1)

    def test_ordinary_chat_is_not_taken_as_an_answer(self):
        self.ask([{"id": "t1", "title": "交作业", "date": "2026-11-16", "clock": "09:00"}])
        self.model.router = lambda prompt: '{"kind":"chat","items":[]}'
        event, out = self.send("今天好累啊")
        self.assertEqual(self.writer.completed, [])
        self.assertFalse(event.stopped)


if __name__ == "__main__":
    unittest.main()
