"""Storage-layer tests."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from . import load_module

store_mod = load_module("store")
Store = store_mod.Store


class StoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "agenda.db"
        self.store = Store(self.db_path, hourly_cap=5)

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def _msg(self, mid: str, ts: int = 1000, group: str = "111", text: str = "明天下午三点开会"):
        return dict(
            message_id=mid,
            group_id=group,
            sender_id="42",
            sender_name="张三",
            ts=ts,
            text=text,
        )

    def test_add_and_dedupe(self) -> None:
        self.assertTrue(self.store.add_message(**self._msg("m1")))
        self.assertFalse(self.store.add_message(**self._msg("m1")))
        self.assertTrue(self.store.add_message(**self._msg("m2")))
        self.assertEqual(len(self.store.pending_messages(10)), 2)

    def test_hourly_cap(self) -> None:
        for i in range(5):
            self.assertTrue(self.store.add_message(**self._msg(f"c{i}")))
        self.assertFalse(self.store.add_message(**self._msg("c5")))
        self.assertEqual(self.store.hourly_count("111", 0), 5)

    def test_claim_and_release(self) -> None:
        self.store.add_message(**self._msg("m1"))
        self.store.add_message(**self._msg("m2"))
        claimed = self.store.claim_batch(1, 10)
        self.assertEqual(len(claimed), 2)
        self.assertEqual(self.store.pending_messages(10), [])
        self.store.release_batch(1)
        self.assertEqual(len(self.store.pending_messages(10)), 2)

    def test_event_dedupe(self) -> None:
        first = self.store.add_event(
            title="产品评审",
            title_norm="产品评审",
            start_at=1700000000,
            end_at=None,
            all_day=False,
            location="A 座 302",
            participants="[]",
            group_id="111",
            source_msg_ids='["m1"]',
            raw_excerpt="明天下午三点开个评审会",
            confidence=0.9,
            status="confirmed",
        )
        self.assertGreater(first, 0)
        hit = self.store.find_similar_event("产品评审", 1700000300)
        self.assertIsNotNone(hit)
        self.assertEqual(hit["id"], first)
        self.assertIsNone(self.store.find_similar_event("产品评审", 1700099999))

    def test_reminder_flow(self) -> None:
        event_id = self.store.add_event(
            title="站会",
            title_norm="站会",
            start_at=1700000000,
            end_at=None,
            all_day=False,
            location=None,
            participants="[]",
            group_id="111",
            source_msg_ids="[]",
            raw_excerpt="",
            confidence=0.9,
            status="confirmed",
        )
        self.store.add_reminder(event_id, 1600000000, "lead30")
        due = self.store.due_reminders(1700000000)
        self.assertEqual(len(due), 1)
        self.assertEqual(due[0]["title"], "站会")
        self.store.mark_reminder_sent(int(due[0]["id"]), 1700000001)
        self.assertEqual(self.store.due_reminders(1700000002), [])

    def test_cancel_drops_pending_reminders(self) -> None:
        event_id = self.store.add_event(
            title="复盘",
            title_norm="复盘",
            start_at=1700000000,
            end_at=None,
            all_day=False,
            location=None,
            participants="[]",
            group_id="111",
            source_msg_ids="[]",
            raw_excerpt="",
            confidence=0.9,
            status="confirmed",
        )
        self.store.add_reminder(event_id, 1600000000, "lead30")
        self.assertTrue(self.store.set_event_status(event_id, "cancelled"))
        self.assertEqual(self.store.due_reminders(1700000000), [])

    def test_state_roundtrip(self) -> None:
        self.assertEqual(self.store.get_state("inbox_umo"), "")
        self.store.set_state("inbox_umo", "aiocqhttp:GroupMessage:9")
        self.assertEqual(self.store.get_state("inbox_umo"), "aiocqhttp:GroupMessage:9")
        self.store.set_state("inbox_umo", "b")
        self.assertEqual(self.store.get_state("inbox_umo"), "b")


if __name__ == "__main__":
    unittest.main()
