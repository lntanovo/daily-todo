"""Tests for the chat-set daily brief: intent parsing and schedule helpers."""

import unittest
from datetime import datetime, timedelta, timezone

from astrbot_plugin_agenda.intent import (
    DailyIntent,
    parse_clock,
    parse_daily_intent,
    push_due,
)

CST = timezone(timedelta(hours=8))


class ClockTest(unittest.TestCase):
    def test_arabic_and_chinese_numbers(self):
        self.assertEqual(parse_clock("每天 9 点"), "09:00")
        self.assertEqual(parse_clock("每天九点"), "09:00")
        self.assertEqual(parse_clock("晚上八点"), "20:00")
        self.assertEqual(parse_clock("下午 3 点半"), "15:30")
        self.assertEqual(parse_clock("23:59"), "23:59")
        self.assertEqual(parse_clock("中午12点"), "12:00")
        self.assertEqual(parse_clock("晚上12点"), "00:00")

    def test_rejects_unusable_clocks(self):
        self.assertIsNone(parse_clock("随便"))
        self.assertIsNone(parse_clock("25点"))
        self.assertIsNone(parse_clock("9点61分"))


class IntentTest(unittest.TestCase):
    def test_set_time(self):
        self.assertEqual(parse_daily_intent("每天 9 点提醒我"), DailyIntent("set", "09:00"))
        self.assertEqual(
            parse_daily_intent("每天晚上八点给我发任务清单"),
            DailyIntent("set", "20:00"),
        )
        self.assertEqual(
            parse_daily_intent("每日 08:30 推送一下任务安排"),
            DailyIntent("set", "08:30"),
        )

    def test_off(self):
        self.assertEqual(parse_daily_intent("取消每天提醒"), DailyIntent("off"))
        self.assertEqual(parse_daily_intent("别每天给我推简报"), DailyIntent("off"))

    def test_show_and_need_time(self):
        self.assertEqual(parse_daily_intent("每天几点提醒我"), DailyIntent("show"))
        self.assertEqual(parse_daily_intent("每天提醒我"), DailyIntent("need_time"))

    def test_unrelated_sentences_are_ignored(self):
        for text in (
            "周五 23:59 交作业",
            "每天都要开心",
            "明天下午三点开会",
            "",
            "今天好累",
        ):
            self.assertIsNone(parse_daily_intent(text), text)

    def test_schedule_with_daily_word_is_not_a_setting(self):
        # 有"每天"也有时间，但说的是任务本身，不应被当成设置
        intent = parse_daily_intent("每天 8 点跑步")
        self.assertIsNone(intent)


class PushDueTest(unittest.TestCase):
    TARGET = "09:00"

    def test_not_before_target(self):
        now = datetime(2026, 11, 17, 8, 59, tzinfo=CST)
        self.assertFalse(push_due(now, self.TARGET, ""))

    def test_first_tick_after_target(self):
        now = datetime(2026, 11, 17, 9, 0, tzinfo=CST)
        self.assertTrue(push_due(now, self.TARGET, ""))
        self.assertFalse(push_due(now, self.TARGET, "2026-11-17"))

    def test_missed_day_sends_after_boot(self):
        now = datetime(2026, 11, 17, 23, 40, tzinfo=CST)
        self.assertTrue(push_due(now, self.TARGET, "2026-11-16"))

    def test_disabled_or_bad_target(self):
        now = datetime(2026, 11, 17, 9, 0, tzinfo=CST)
        self.assertFalse(push_due(now, "", ""))
        self.assertFalse(push_due(now, "9:00", ""))


if __name__ == "__main__":
    unittest.main()
