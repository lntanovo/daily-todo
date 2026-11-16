"""Tests for the "完成了吗" follow-up: due detection, wording, reply parsing."""

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from astrbot_plugin_agenda.followup import (
    clock_of,
    due_rows,
    render_question,
    selection,
)
from astrbot_plugin_agenda.store import CST, Store

NOW = datetime(2026, 11, 16, 17, 0, tzinfo=CST)


def task(task_id="t1", title="交作业", day="2026-11-16", clock="16:30"):
    return {"id": task_id, "title": title, "date": day, "time": clock}


class DueRowsTest(unittest.TestCase):
    def test_due_after_grace(self):
        rows = due_rows([task()], now=NOW, grace_min=15)
        self.assertEqual([row["id"] for row in rows], ["t1"])
        self.assertEqual(rows[0]["clock"], "16:30")

    def test_not_due_before_time_or_inside_grace(self):
        self.assertEqual(due_rows([task(clock="17:30")], now=NOW), [])
        self.assertEqual(due_rows([task(clock="16:50")], now=NOW), [])

    def test_grace_zero_asks_right_at_the_time(self):
        self.assertEqual(len(due_rows([task(clock="17:00")], now=NOW, grace_min=0)), 1)

    def test_stale_items_are_dropped(self):
        self.assertEqual(due_rows([task(clock="03:00")], now=NOW, stale_hours=12), [])

    def test_yesterday_late_task_still_due_after_midnight(self):
        rows = due_rows(
            [task(day="2026-11-15", clock="23:59")],
            now=datetime(2026, 11, 16, 0, 20, tzinfo=CST),
            grace_min=0,
        )
        self.assertEqual(len(rows), 1)

    def test_default_time_when_task_has_no_clock(self):
        self.assertEqual(clock_of({"time": ""}), "20:00")
        self.assertEqual(due_rows([task(clock="")], now=NOW), [])
        self.assertEqual(
            len(due_rows([task(clock="")], now=datetime(2026, 11, 16, 20, 30, tzinfo=CST))),
            1,
        )

    def test_limit_keeps_earliest(self):
        rows = [task(task_id=f"t{i}", clock=f"{9 + i:02d}:00") for i in range(8)]
        picked = due_rows(rows, now=NOW, limit=6)
        self.assertEqual(len(picked), 6)
        self.assertEqual(picked[0]["id"], "t0")


class RenderTest(unittest.TestCase):
    def test_single(self):
        text = render_question(due_rows([task()], now=NOW), now=NOW)
        self.assertIn("交作业", text)
        self.assertIn("16:30", text)
        self.assertIn("回「完成」", text)

    def test_many_are_numbered_once(self):
        rows = due_rows(
            [task(task_id="a", title="交作业", clock="09:00"),
             task(task_id="b", title="党校培训", clock="16:30")],
            now=NOW,
        )
        text = render_question(rows, now=NOW)
        self.assertIn("这 2 项", text)
        self.assertIn("1. 交作业", text)
        self.assertIn("2. 党校培训", text)
        self.assertIn("「1 3」", text)

    def test_yesterday_label(self):
        rows = due_rows(
            [task(day="2026-11-15", clock="23:59")],
            now=datetime(2026, 11, 16, 0, 20, tzinfo=CST),
            grace_min=0,
        )
        self.assertIn("昨天 23:59", render_question(rows, now=datetime(2026, 11, 16, 0, 20, tzinfo=CST)))


class SelectionTest(unittest.TestCase):
    def test_done_everything(self):
        for text in ("完成", "完成了", "都完成了", "搞定", "done"):
            self.assertEqual(selection(text, 3), [1, 2, 3], text)

    def test_done_some(self):
        self.assertEqual(selection("完成 1 3", 3), [1, 3])
        self.assertEqual(selection("1 3", 3), [1, 3])
        self.assertEqual(selection("第2条", 3), [2])

    def test_not_done(self):
        for text in ("没做", "还没", "算了", "0"):
            self.assertEqual(selection(text, 3), [], text)

    def test_prose_is_not_an_answer(self):
        self.assertEqual(selection("今天好累", 3), None)
        self.assertEqual(selection("周五交作业", 3), None)
        self.assertEqual(selection("9", 3), None)


class FollowupStoreTest(unittest.TestCase):
    def test_claim_is_idempotent_and_resolvable(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "agenda.db")
            try:
                rows = [{"id": "t1", "title": "交作业", "date": "2026-11-16", "clock": "16:30"}]
                self.assertEqual(len(store.claim_followups(rows)), 1)
                self.assertEqual(store.claim_followups(rows), [])  # 不重复问
                opened = store.open_followups()
                self.assertEqual([row["task_id"] for row in opened], ["t1"])
                store.resolve_followups([opened[0]["id"]], "done")
                self.assertEqual(store.open_followups(), [])
                # 已答过的那条今天不会再被问
                self.assertEqual(store.claim_followups(rows), [])
                # 换一天可以再问
                tomorrow = [{**rows[0], "date": "2026-11-17"}]
                self.assertEqual(len(store.claim_followups(tomorrow)), 1)
            finally:
                store.close()

    def test_send_failure_can_be_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "agenda.db")
            try:
                rows = [{"id": "t1", "title": "交作业", "date": "2026-11-16", "clock": "16:30"}]
                store.claim_followups(rows)
                store.drop_followup("t1", "2026-11-16")
                self.assertEqual(store.open_followups(), [])
                self.assertEqual(len(store.claim_followups(rows)), 1)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
