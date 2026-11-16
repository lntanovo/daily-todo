"""Tests for the startup catch-up: history selection and the confirm queue.

Kept offline: no AstrBot, no OneBot, no network.
"""

import tempfile
import unittest
from pathlib import Path

from astrbot_plugin_agenda.catchup import MissedBatch, message_text, select_candidates
from astrbot_plugin_agenda.store import Store

OWNER = "10001"
BOT = "99999"


def msg(mid, ts, text, uid=OWNER):
    """Build one OneBot history entry shaped like SnowLuma's reply."""
    return {
        "message_id": int(mid),
        "time": int(ts),
        "user_id": int(uid),
        "message": [{"type": "text", "data": {"text": text}}],
    }


class MessageTextTest(unittest.TestCase):
    def test_segment_array(self):
        self.assertEqual(
            message_text(
                {
                    "message": [
                        {"type": "text", "data": {"text": "周五 "}},
                        {"type": "image", "data": {"file": "x.jpg"}},
                        {"type": "text", "data": {"text": "交作业"}},
                    ]
                }
            ),
            "周五 交作业",
        )

    def test_plain_string_and_empty(self):
        self.assertEqual(message_text({"message": "  交作业 "}), "交作业")
        self.assertEqual(message_text({"message": []}), "")
        self.assertEqual(message_text({"message": "   "}), "")
        self.assertEqual(message_text({"message": None}), "")
        self.assertEqual(message_text("not a dict"), "")


class SelectCandidatesTest(unittest.TestCase):
    NOW = 1_800_000_000

    def run_select(self, messages, since=0, **kwargs):
        return select_candidates(
            messages, owner_id=OWNER, since_ts=since, now=self.NOW, **kwargs
        )

    def test_only_owner_and_only_after_watermark(self):
        batch = self.run_select(
            [
                msg(1, self.NOW - 100, "老师说周五交实验报告"),
                msg(2, self.NOW - 90, "先跟你对一下：交作业", uid=BOT),
                msg(3, self.NOW - 80, "昨天聊过的事", uid="999"),
                msg(4, self.NOW - 70, "下周三上午十点讲座"),
            ],
            since=self.NOW - 95,
        )
        self.assertEqual([row["message_id"] for row in batch.fresh], ["4"])
        self.assertEqual(batch.newest_ts, self.NOW - 70)
        self.assertEqual(batch.stale, 0)

    def test_short_messages_advance_watermark_but_are_not_asked(self):
        batch = self.run_select(
            [
                msg(1, self.NOW - 50, "嗯"),
                msg(2, self.NOW - 40, "1"),
                msg(3, self.NOW - 30, "好的"),
            ]
        )
        self.assertEqual(batch.fresh, [])
        self.assertEqual(batch.newest_ts, self.NOW - 30)

    def test_old_messages_are_counted_not_asked(self):
        batch = self.run_select(
            [
                msg(1, self.NOW - 8 * 86400, "很久以前的作业"),
                msg(2, self.NOW - 2 * 86400, "前天的作业"),
            ],
            max_age_days=7,
        )
        self.assertEqual([row["message_id"] for row in batch.fresh], ["2"])
        self.assertEqual(batch.stale, 1)

    def test_oldest_first_then_limit_keeps_newest(self):
        messages = [msg(i, self.NOW - 100 + i * 10, f"作业{i}说明") for i in range(1, 6)]
        batch = self.run_select(messages, limit=3)
        self.assertEqual([row["message_id"] for row in batch.fresh], ["3", "4", "5"])
        self.assertEqual(batch.dropped, 2)
        self.assertEqual(
            sorted(row["ts"] for row in batch.fresh), [row["ts"] for row in batch.fresh]
        )

    def test_empty_history_is_a_noop(self):
        batch = self.run_select(None, since=123)
        self.assertEqual(batch.fresh, [])
        self.assertEqual(batch.stale, 0)
        self.assertEqual(batch.newest_ts, 123)

    def test_string_message_field(self):
        batch = self.run_select(
            [{"message_id": 9, "time": self.NOW - 5, "user_id": int(OWNER), "message": "周五交作业"}]
        )
        self.assertEqual(batch.fresh[0]["text"], "周五交作业")

    def test_batch_defaults(self):
        self.assertEqual(MissedBatch().newest_ts, 0)


class CatchupQueueTest(unittest.TestCase):
    def test_queue_lifecycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "agenda.db")
            try:
                self.assertTrue(
                    store.enqueue_catchup(
                        chat_key="umo",
                        message_id="m1",
                        ts=100,
                        raw_text="原句一",
                        payload='{"title":"一","date":"2026-11-20"}',
                    )
                )
                # 同一条消息只排一次
                self.assertFalse(
                    store.enqueue_catchup(
                        chat_key="umo",
                        message_id="m1",
                        ts=100,
                        raw_text="原句一",
                        payload="{}",
                    )
                )
                self.assertTrue(
                    store.enqueue_catchup(
                        chat_key="umo",
                        message_id="m2",
                        ts=200,
                        raw_text="原句二",
                        payload='{"title":"二","date":"2026-11-21"}',
                    )
                )
                self.assertTrue(store.has_catchup("m1"))
                self.assertEqual(store.catchup_count("umo"), 2)

                first = store.next_catchup("umo")
                assert first is not None
                self.assertEqual(first["message_id"], "m1")
                store.mark_catchup(int(first["id"]), "asked")
                self.assertIsNotNone(store.asked_catchup("umo"))
                self.assertEqual(store.catchup_count("umo"), 1)

                second = store.next_catchup("umo")
                assert second is not None
                self.assertEqual(second["message_id"], "m2")
                store.mark_catchup(int(second["id"]), "done")
                store.mark_catchup(int(first["id"]), "skipped")
                self.assertIsNone(store.next_catchup("umo"))
                self.assertIsNone(store.asked_catchup("umo"))
                self.assertEqual(store.catchup_count("umo"), 0)
            finally:
                store.close()

    def test_purge_only_finished_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "agenda.db")
            try:
                store.enqueue_catchup(
                    chat_key="umo", message_id="old", ts=1, raw_text="a", payload="{}"
                )
                row = store.next_catchup("umo")
                assert row is not None
                store.mark_catchup(int(row["id"]), "done")
                store.enqueue_catchup(
                    chat_key="umo", message_id="new", ts=2, raw_text="b", payload="{}"
                )
                store.purge_catchup(0)
                self.assertEqual(store.catchup_count("umo"), 1)
                self.assertFalse(store.has_catchup("old"))
                self.assertTrue(store.has_catchup("new"))
            finally:
                store.close()

    def test_pending_and_queue_are_independent(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "agenda.db")
            try:
                store.add_pending("umo", "原句", '{"title":"x"}')
                store.enqueue_catchup(
                    chat_key="umo", message_id="m1", ts=1, raw_text="a", payload="{}"
                )
                store.drop_pending(int(store.latest_pending("umo")["id"]))
                self.assertIsNone(store.latest_pending("umo"))
                self.assertEqual(store.catchup_count("umo"), 1)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
