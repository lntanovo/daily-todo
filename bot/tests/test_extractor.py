"""Extraction-layer tests: prompt building, JSON parsing and normalisation."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from . import load_module

ext = load_module("extractor")
CST = timezone(timedelta(hours=8))


class PromptTest(unittest.TestCase):
    def test_prompt_contains_time_and_messages(self) -> None:
        now = datetime(2026, 11, 13, 9, 0, tzinfo=CST)
        rows = [
            {
                "message_id": "m1",
                "ts": int(datetime(2026, 11, 13, 8, 30, tzinfo=CST).timestamp()),
                "sender_name": "张三",
                "text": "明天下午三点开会，A 座 302",
            }
        ]
        prompt = ext.build_prompt(rows, now=now, max_chars=50)
        self.assertIn("2026-11-13", prompt)
        self.assertIn("m1", prompt)
        self.assertIn("张三", prompt)
        self.assertIn("明天下午三点开会", prompt)

    def test_prompt_truncates_long_text(self) -> None:
        rows = [{"message_id": "m", "ts": 0, "sender_name": "a", "text": "字" * 500}]
        prompt = ext.build_prompt(
            rows, now=datetime(2026, 1, 1, tzinfo=CST), max_chars=20
        )
        self.assertIn("…", prompt)
        self.assertNotIn("字" * 30, prompt)


class ParseTest(unittest.TestCase):
    def test_parse_plain_json(self) -> None:
        raw = (
            '{"events":[{"title":"产品评审","start_at":"2026-11-14T15:00:00+08:00",'
            '"end_at":null,"all_day":false,"location":"A 座 302",'
            '"participants":["张三"],"source_msg_ids":["m1"],"confidence":0.9}]}'
        )
        drafts = ext.parse_events(raw)
        self.assertEqual(len(drafts), 1)
        draft = drafts[0]
        self.assertEqual(draft.title, "产品评审")
        self.assertEqual(draft.location, "A 座 302")
        self.assertAlmostEqual(draft.confidence, 0.9)
        self.assertEqual(draft.source_msg_ids, ["m1"])
        expected = int(datetime(2026, 11, 14, 15, 0, tzinfo=CST).timestamp())
        self.assertEqual(draft.start_at, expected)

    def test_parse_fenced_json(self) -> None:
        raw = '```json\n{"events":[]}\n```'
        self.assertEqual(ext.parse_events(raw), [])

    def test_parse_with_prose_around_json(self) -> None:
        raw = '好的，结果如下：{"events":[]} 以上。'
        self.assertEqual(ext.parse_events(raw), [])

    def test_parse_rejects_garbage(self) -> None:
        with self.assertRaises(ValueError):
            ext.parse_events("对不起，我无法完成")

    def test_parse_drops_titleless_and_normalises_bad_confidence(self) -> None:
        raw = (
            '{"events":[{"title":"","start_at":null},'
            '{"title":"备份","start_at":null,"confidence":"unknown"}]}'
        )
        drafts = ext.parse_events(raw)
        self.assertEqual(len(drafts), 1)
        self.assertEqual(drafts[0].title, "备份")
        self.assertEqual(drafts[0].confidence, 0.0)

    def test_parse_naive_datetime_assumes_cst(self) -> None:
        raw = '{"events":[{"title":"x","start_at":"2026-11-14T09:00:00"}]}'
        draft = ext.parse_events(raw)[0]
        expected = int(datetime(2026, 11, 14, 9, 0, tzinfo=CST).timestamp())
        self.assertEqual(draft.start_at, expected)


class NormaliseTest(unittest.TestCase):
    def test_titles_with_punctuation_collapse(self) -> None:
        a = ext.normalize_title("产品评审会")
        b = ext.normalize_title("产品评审会！")
        c = ext.normalize_title("  产品 评审会 ")
        self.assertEqual(a, b)
        self.assertEqual(a, c)

    def test_noise_is_filtered(self) -> None:
        self.assertFalse(ext.is_worth_storing("。。。"))
        self.assertFalse(ext.is_worth_storing("😂😂😂", 4))
        self.assertFalse(ext.is_worth_storing("好", 4))
        self.assertTrue(ext.is_worth_storing("明天下午三点开会", 4))


if __name__ == "__main__":
    unittest.main()
