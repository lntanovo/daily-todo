"""Tests for the read-only task overview behind /任务 and /提醒.

Offline: the transport is a fake callable, so no network and no AstrBot.
"""

import json
import unittest
from datetime import date

from astrbot_plugin_agenda.cloud_reader import (
    CloudReader,
    ReaderError,
    appears_on,
    build_overview,
    clock_of,
    format_overview,
    format_settings,
    parse_date,
    rule_appears,
)


class DateHelpersTest(unittest.TestCase):
    def test_parse_date(self):
        self.assertEqual(parse_date("2026-11-20"), date(2026, 11, 20))
        self.assertIsNone(parse_date("2026-2-30"))
        self.assertIsNone(parse_date("2026/11/20"))
        self.assertIsNone(parse_date(None))

    def test_clock_falls_back_to_start_time(self):
        self.assertEqual(clock_of({"remind_time": "23:59:00"}), "23:59")
        self.assertEqual(clock_of({"remind_time": None, "start_time": "09:05:00"}), "09:05")
        self.assertEqual(clock_of({}), "")


class AppearanceTest(unittest.TestCase):
    def test_single_and_range(self):
        self.assertTrue(appears_on({"type": "single", "task_date": "2026-11-20"}, date(2026, 11, 20), {}))
        self.assertFalse(appears_on({"type": "single", "task_date": "2026-11-20"}, date(2026, 11, 21), {}))
        task = {"type": "range", "start_date": "2026-11-18", "end_date": "2026-11-20"}
        self.assertTrue(appears_on(task, date(2026, 11, 18), {}))
        self.assertTrue(appears_on(task, date(2026, 11, 20), {}))
        self.assertFalse(appears_on(task, date(2026, 11, 21), {}))

    def test_weekly_rule_respects_window(self):
        rule = {
            "frequency": "weekly",
            "weekdays": [1, 3, 5],  # 周一/三/五
            "start_date": "2026-11-16",
            "end_date": "2026-11-30",
        }
        self.assertTrue(rule_appears(rule, date(2026, 11, 16)))  # 周一
        self.assertFalse(rule_appears(rule, date(2026, 11, 17)))  # 周二
        self.assertFalse(rule_appears(rule, date(2026, 11, 15)))  # 窗口前
        self.assertFalse(rule_appears(rule, date(2026, 12, 2)))  # 窗口后

    def test_monthly_rule(self):
        rule = {"frequency": "monthly", "month_day": 30, "start_date": "2026-01-01"}
        self.assertTrue(rule_appears(rule, date(2026, 4, 30)))
        self.assertFalse(rule_appears(rule, date(2026, 4, 29)))
        # 2 月没有 30 号，规则不会凭空补到月底
        self.assertFalse(rule_appears(rule, date(2026, 2, 28)))

    def test_recurring_task_uses_rule_table(self):
        task = {"id": "t1", "type": "recurring"}
        rules = {"t1": {"frequency": "weekly", "weekdays": [6], "start_date": "2026-11-01"}}
        self.assertTrue(appears_on(task, date(2026, 11, 21), rules))  # 周六
        self.assertFalse(appears_on(task, date(2026, 11, 20), rules))
        self.assertFalse(appears_on(task, date(2026, 11, 21), {}))


class BuildOverviewTest(unittest.TestCase):
    TODAY = date(2026, 11, 16)

    def make(self, tasks, completions=None, recurrences=None, **kwargs):
        return build_overview(
            tasks,
            recurrences or [],
            completions or [],
            today=self.TODAY,
            **kwargs,
        )

    def test_groups_and_completion(self):
        tasks = [
            {"id": "a", "title": "逾期作业", "type": "single", "task_date": "2026-11-14"},
            {"id": "b", "title": "今天开会", "type": "single", "task_date": "2026-11-16",
             "remind_time": "15:00:00"},
            {"id": "c", "title": "周五交作业", "type": "single", "task_date": "2026-11-20",
             "remind_time": "23:59:00"},
            {"id": "d", "title": "已完成的", "type": "single", "task_date": "2026-11-16"},
        ]
        completions = [
            {"task_id": "d", "completion_date": "2026-11-16", "completed": True},
            {"task_id": "a", "completion_date": "2026-11-14", "completed": False},
        ]
        overview = self.make(tasks, completions, days=7)
        self.assertEqual([row["id"] for row in overview.overdue], ["a"])
        self.assertEqual([row["id"] for row in overview.today_items], ["b"])
        self.assertEqual([row["id"] for row in overview.upcoming], ["c"])
        self.assertEqual(overview.upcoming[0]["days"], 4)

    def test_overdue_cutoff_and_completed_exclusion(self):
        tasks = [
            {"id": "old", "title": "太久以前", "type": "single", "task_date": "2026-09-01"},
            {"id": "done", "title": "做完了", "type": "single", "task_date": "2026-11-10"},
        ]
        overview = self.make(
            tasks, [{"task_id": "done", "completion_date": "2026-11-10", "completed": True}]
        )
        self.assertEqual(overview.overdue, [])

    def test_range_and_recurring_appear_in_window(self):
        tasks = [
            {"id": "r", "title": "训练营", "type": "range",
             "start_date": "2026-11-17", "end_date": "2026-11-19"},
            {"id": "w", "title": "每周例会", "type": "recurring", "start_time": "10:00:00"},
        ]
        recurrences = [
            {"task_id": "w", "frequency": "weekly", "weekdays": [3],
             "start_date": "2026-11-01", "end_date": None}
        ]
        overview = self.make(tasks, recurrences=recurrences, days=7)
        dates = [(row["id"], row["date"]) for row in overview.upcoming]
        self.assertIn(("r", "2026-11-17"), dates)
        self.assertIn(("r", "2026-11-19"), dates)
        self.assertIn(("w", "2026-11-18"), dates)  # 周三

    def test_completion_only_skips_that_day(self):
        tasks = [{"id": "w", "title": "打卡", "type": "recurring"}]
        recurrences = [
            {"task_id": "w", "frequency": "weekly", "weekdays": [2], "start_date": "2026-11-01"}
        ]
        overview = self.make(
            tasks,
            [{"task_id": "w", "completion_date": "2026-11-17", "completed": True}],
            recurrences,
            days=8,
        )
        dates = [row["date"] for row in overview.upcoming]
        self.assertNotIn("2026-11-17", dates)
        self.assertIn("2026-11-24", dates)

    def test_caps_are_counted_as_truncated(self):
        tasks = [
            {"id": f"t{i}", "title": f"任务{i}", "type": "single", "task_date": "2026-11-16"}
            for i in range(15)
        ]
        overview = self.make(tasks, max_today=10)
        self.assertEqual(len(overview.today_items), 10)
        self.assertEqual(overview.truncated, 5)


class FormatTest(unittest.TestCase):
    TODAY = date(2026, 11, 16)

    def test_empty_state(self):
        overview = build_overview([], [], [], today=self.TODAY)
        self.assertIn("没有未完成的任务", format_overview(overview))

    def test_sections_and_relative_labels(self):
        tasks = [
            {"id": "a", "title": "逾期作业", "type": "single", "task_date": "2026-11-14"},
            {"id": "b", "title": "今天开会", "type": "single", "task_date": "2026-11-16",
             "remind_time": "15:00:00"},
            {"id": "c", "title": "交作业", "type": "single", "task_date": "2026-11-20",
             "remind_time": "23:59:00"},
            {"id": "d", "title": "跑步", "type": "single", "task_date": "2026-11-17"},
        ]
        text = format_overview(build_overview(tasks, [], [], today=self.TODAY, days=7))
        self.assertIn("逾期 1 项", text)
        self.assertIn("逾期 2 天", text)
        self.assertIn("今天 1 项", text)
        self.assertIn("明天 跑步", text)
        self.assertIn("11-20 23:59 交作业", text)
        self.assertNotIn("2026-11-20", text)
        self.assertIn("未来 7 天", text)

    def test_settings_block(self):
        text = format_settings(
            {
                "digest_time": "08:00:00",
                "evening_time": "20:30:00",
                "remind_lead_days": 3,
                "digest_enabled": True,
                "evening_enabled": True,
                "quiet_start": None,
                "quiet_end": None,
            }
        )
        self.assertIn("早报 08:00（开）", text)
        self.assertIn("晚间收尾 20:30（开）", text)
        self.assertIn("提前 3 天", text)
        self.assertIn("免打扰 未设置", text)
        self.assertIn("还没配提醒设置", format_settings(None))


class FakeTransport:
    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.urls = []

    def __call__(self, method, url, headers, body):
        self.urls.append(url)
        return (200, json.dumps(self.payloads.pop(0)))


class CloudReaderTest(unittest.TestCase):
    def make(self, payloads):
        transport = FakeTransport(payloads)
        reader = CloudReader("env-1", "key-1", "lnreg_x", request=transport)
        return reader, transport

    def test_overview_queries_and_parses(self):
        reader, transport = self.make(
            [
                [{"id": "a", "title": "交作业", "type": "single", "task_date": "2026-11-20"}],
                [],
                [],
                [{"remind_lead_days": 5, "digest_time": "08:00:00"}],
            ]
        )
        overview = reader.overview(days=7, today=date(2026, 11, 16))
        self.assertEqual([row["title"] for row in overview.upcoming], ["交作业"])
        self.assertEqual(overview.lead_days, 5)
        self.assertIn("/todo_tasks?owner_id=eq.lnreg_x&deleted_at=is.null", transport.urls[0])
        self.assertIn("/todo_task_recurrences?owner_id=eq.lnreg_x", transport.urls[1])
        self.assertIn("/todo_daily_completions?owner_id=eq.lnreg_x", transport.urls[2])
        self.assertIn("/todo_reminder_settings?owner_id=eq.lnreg_x", transport.urls[3])

    def test_http_error_raises(self):
        def failing(method, url, headers, body):
            return (500, "boom")

        reader = CloudReader("env-1", "key-1", "lnreg_x", request=failing)
        with self.assertRaises(ReaderError) as ctx:
            reader.overview(today=date(2026, 11, 16))
        self.assertIn("HTTP_500", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
