"""Tests for the private-chat capture path: parsing, drafts and cloud writes.

Kept offline: the cloud transport is a fake callable, so no network and no
AstrBot runtime are needed. ``fixtures/training_notice.txt`` is the real four-
session notice that the old single-item parser turned into one task.
"""

import json
import tempfile
import unittest
from pathlib import Path

from astrbot_plugin_agenda.capture import (
    build_capture_prompt,
    clean_title,
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
from astrbot_plugin_agenda.cloud_writer import (
    CloudWriter,
    WriterError,
    is_valid_date,
    normalize,
)
from astrbot_plugin_agenda.store import Store

FIXTURE = Path(__file__).with_name("fixtures") / "training_notice.txt"
NOTICE = FIXTURE.read_text(encoding="utf-8")

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
                "confidence": 0.92,
            }
        ],
    },
    ensure_ascii=False,
)

REPLY_REST = json.dumps(
    {
        "kind": "schedule",
        "items": [
            {
                "seg": "S2",
                "title": "党的二十届五中全会精神专题报告",
                "date": "2026-12-01",
                "time": "16:30",
                "kind": "event",
                "confidence": 0.9,
            },
            {
                "seg": "S3",
                "title": "学习党章党规",
                "date": "2026-11-20",
                "time": "16:30",
                "kind": "event",
                "confidence": 0.9,
            },
            {
                "seg": "S4",
                "title": "世界社会主义运动与中国共产党",
                "date": "2026-11-25",
                "time": "16:30",
                "kind": "event",
                "confidence": 0.9,
            },
        ]
    },
    ensure_ascii=False,
)


class SegmentationTest(unittest.TestCase):
    def test_notice_splits_into_four_numbered_segments(self):
        segments = segment_message(NOTICE)
        self.assertEqual([seg.sid for seg in segments], ["S1", "S2", "S3", "S4"])
        self.assertIn("习近平党建思想专题报告", segments[0].text)
        self.assertIn("12月1日", segments[1].text)
        self.assertIn("11月20日", segments[2].text)
        self.assertIn("11月25日", segments[3].text)

    def test_headers_and_preamble_are_not_segments(self):
        segments = segment_message(NOTICE)
        joined = "\n".join(seg.text for seg in segments)
        self.assertNotIn("合班授课", joined)
        self.assertNotIn("请组长统计", joined)

    def test_single_sentence(self):
        segments = segment_message("周五23:59交作业")
        self.assertEqual(len(segments), 1)
        self.assertIn("23:59", segments[0].times)
        self.assertIn("作业", segments[0].text)

    def test_chat_with_a_time_word_is_left_to_the_model(self):
        # "今天"会切出一段，由模型标 skip；不能靠规则把整句吞掉。
        self.assertEqual(len(segment_message("今天好累啊，晚上不想动")), 1)
        self.assertEqual(segment_message("哈哈哈哈"), [])

    def test_skip_answer_closes_the_segment(self):
        segments = segment_message("今天好累啊")
        _, items = parse_capture_reply('{"items":[{"seg":"S1","skip":true}]}')
        self.assertEqual(missing_segments(segments, items), [])
        self.assertEqual(items_payload(items)["items"], [])

    def test_max_segments_caps_the_list(self):
        text = "\n".join(f"{i}、任务{i} 11月{10 + i}日 16:30" for i in range(1, 6))
        self.assertEqual(len(segment_message(text, max_segments=3)), 3)

    def test_prompt_numbers_every_segment(self):
        segments = segment_message(NOTICE)
        prompt = build_capture_prompt(NOTICE, segments)
        for sid in ("S1", "S2", "S3", "S4"):
            self.assertIn(f"[{sid}]", prompt)
        self.assertIn("4 段", prompt)

    def test_prompt_without_segments_still_asks_for_judgement(self):
        prompt = build_capture_prompt("记得给老师发邮件", [])
        self.assertIn("记得给老师发邮件", prompt)
        self.assertIn("安排还是闲聊", prompt)


class CoverageTest(unittest.TestCase):
    def test_missing_segments_are_detected(self):
        segments = segment_message(NOTICE)
        _, items = parse_capture_reply(REPLY_ONE)
        missing = missing_segments(segments, items)
        self.assertEqual([seg.sid for seg in missing], ["S2", "S3", "S4"])

    def test_repair_round_closes_the_gap(self):
        segments = segment_message(NOTICE)
        _, items = parse_capture_reply(REPLY_ONE)
        _, more = parse_capture_reply(REPLY_REST)
        merged = merge_items(items, more)
        self.assertEqual(len(merged), 4)
        self.assertEqual(missing_segments(segments, merged), [])

    def test_duplicate_segment_is_not_merged_twice(self):
        _, first = parse_capture_reply(REPLY_ONE)
        _, again = parse_capture_reply(REPLY_ONE)
        self.assertEqual(len(merge_items(first, again)), 1)


class CaptureParseTest(unittest.TestCase):
    def test_markdown_fence_and_numeric_seg(self):
        raw = (
            "```json\n"
            '{"kind":"schedule","items":[{"seg":"1","title":"交作业",'
            '"date":"2026-11-19","time":"23:59","kind":"deadline"}]}\n'
            "```"
        )
        kind, items = parse_capture_reply(raw)
        self.assertEqual(kind, "schedule")
        self.assertEqual(items[0].seg, "S1")
        self.assertEqual(items[0].kind, "deadline")

    def test_invalid_fields_are_dropped_not_guessed(self):
        _, items = parse_capture_reply(
            '{"items":[{"title":"作业","date":"2026-02-30","time":"24:00","kind":"x"}]}'
        )
        self.assertIsNone(items[0].date)
        self.assertIsNone(items[0].time)
        self.assertEqual(items[0].kind, "task")

    def test_alternate_keys_are_tolerated(self):
        for raw in (
            '{"events":[{"title":"体检","date":"2026-11-21"}]}',
            '{"item":{"title":"体检","date":"2026-11-21"}}',
        ):
            _, items = parse_capture_reply(raw)
            self.assertEqual(items[0].title, "体检")

    def test_chat_reply_gives_no_items(self):
        kind, items = parse_capture_reply('{"kind":"chat","items":[]}')
        self.assertEqual(kind, "chat")
        self.assertEqual(items, [])

    def test_entries_without_title_become_skip_markers(self):
        _, items = parse_capture_reply('{"items":[{"seg":"S1","date":"2026-11-17"}]}')
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0].skipped)
        self.assertEqual(items_payload(items)["items"], [])

    def test_clean_title_strips_enumeration_and_noise(self):
        self.assertEqual(clean_title("2、学习贯彻精神提示"), "学习贯彻精神提示")
        self.assertEqual(clean_title("提醒我交作业。"), "交作业")

    def test_task_cue_fallback(self):
        self.assertTrue(looks_like_task("记得给老师发邮件"))
        self.assertTrue(looks_like_task("这个月报名截止"))
        self.assertFalse(looks_like_task("今天好累啊"))


class DraftTest(unittest.TestCase):
    def build_payload(self):
        segments = segment_message(NOTICE)
        _, items = parse_capture_reply(REPLY_ONE)
        _, more = parse_capture_reply(REPLY_REST)
        return items_payload(merge_items(items, more), raw=NOTICE, missing=[])

    def test_multi_draft_lists_every_item(self):
        text = render_draft(self.build_payload())
        self.assertIn("一共 4 条", text)
        self.assertIn("习近平党建思想专题报告", text)
        self.assertIn("世界社会主义运动与中国共产党", text)
        self.assertIn("2026-12-01", text)
        self.assertIn("回「1 3」", text)

    def test_missing_segments_are_named(self):
        segments = segment_message(NOTICE)
        _, items = parse_capture_reply(REPLY_ONE)
        payload = items_payload(items, missing=missing_segments(segments, items))
        text = render_draft(payload)
        self.assertIn("还有 3 段", text)

    def test_single_draft_keeps_old_wording(self):
        payload = {"title": "交作业", "date": "2026-11-20", "time": "23:59"}
        self.assertEqual(payload_items(payload)[0]["title"], "交作业")
        text = render_draft(payload)
        self.assertIn("先跟你对一下", text)
        self.assertIn("回「1」存进日程", text)

    def test_v2_payload_round_trip(self):
        payload = json.loads(json.dumps(self.build_payload(), ensure_ascii=False))
        self.assertEqual(len(payload_items(payload)), 4)
        self.assertEqual(payload["items"][1]["date"], "2026-12-01")


class SelectionTest(unittest.TestCase):
    def test_all(self):
        self.assertEqual(parse_selection("全部", 4), [1, 2, 3, 4])

    def test_subset(self):
        self.assertEqual(parse_selection("1 3", 4), [1, 3])
        self.assertEqual(parse_selection("只存 2、4", 4), [2, 4])
        self.assertEqual(parse_selection("第3条", 4), [3])

    def test_commands_are_not_selections(self):
        self.assertIsNone(parse_selection("1", 4))
        self.assertIsNone(parse_selection("2", 4))

    def test_prose_is_not_a_selection(self):
        self.assertIsNone(parse_selection("今天好累", 4))

    def test_out_of_range_is_ignored(self):
        self.assertIsNone(parse_selection("9", 4))


class WriterValidationTest(unittest.TestCase):
    OWNER = "lnreg_owner"

    def test_valid_date(self):
        self.assertTrue(is_valid_date("2026-11-19"))
        self.assertFalse(is_valid_date("2026-02-30"))
        self.assertFalse(is_valid_date("2026-1-9"))

    def test_row_defaults(self):
        row = normalize({"title": " 交  作业 ", "date": "2026-11-19"}, self.OWNER)
        self.assertEqual(row["title"], "交 作业")
        self.assertEqual(row["remind_time"], "20:00")
        self.assertTrue(row["remind_enabled"])
        self.assertEqual(row["type"], "single")

    def test_rejects_bad_payloads(self):
        for payload, code in [
            ({"title": "", "date": "2026-11-19"}, "INVALID_TITLE"),
            ({"title": "x" * 161, "date": "2026-11-19"}, "INVALID_TITLE"),
            ({"title": "作业", "date": "2026-02-30"}, "INVALID_DATE"),
            ({"title": "作业", "date": "2026-11-19", "time": "9:30"}, "INVALID_TIME"),
            ({"title": "作业", "date": "2026-11-19", "kind": "meeting"}, "INVALID_KIND"),
        ]:
            with self.assertRaises(WriterError) as ctx:
                normalize(payload, self.OWNER)
            self.assertEqual(str(ctx.exception), code)


class FakeTransport:
    def __init__(self, get_body="[]", post_body="[{}]"):
        self.calls = []
        self.get_body = get_body
        self.post_body = post_body

    def __call__(self, method, url, headers, body):
        self.calls.append({"method": method, "url": url, "body": body, "headers": headers})
        return (200, self.get_body if method == "GET" else self.post_body)


class WriterHttpTest(unittest.TestCase):
    OWNER = "lnreg_owner"

    def make(self, transport):
        return CloudWriter("env-1", "key-1", self.OWNER, request=transport)

    def test_insert_once(self):
        transport = FakeTransport()
        result = self.make(transport).write(
            {"title": "交作业", "date": "2026-11-19", "time": "23:59"}
        )
        self.assertFalse(result["duplicate"])
        self.assertEqual(result["time"], "23:59")
        methods = [call["method"] for call in transport.calls]
        self.assertEqual(methods, ["GET", "POST"])
        row = json.loads(transport.calls[1]["body"])
        self.assertEqual(row["task_date"], "2026-11-19")
        self.assertEqual(row["remind_time"], "23:59")
        self.assertEqual(row["owner_id"], self.OWNER)

    def test_duplicate_skips_insert(self):
        transport = FakeTransport(get_body='[{"id":"a1b2"}]')
        result = self.make(transport).write({"title": "交作业", "date": "2026-11-19"})
        self.assertTrue(result["duplicate"])
        self.assertEqual(result["id"], "a1b2")
        self.assertEqual([call["method"] for call in transport.calls], ["GET"])

    def test_chinese_title_is_url_encoded(self):
        transport = FakeTransport()
        self.make(transport).write({"title": "交 作业", "date": "2026-11-19"})
        self.assertIn("%E4%BA%A4", transport.calls[0]["url"])
        self.assertIn("%20", transport.calls[0]["url"])

    def test_http_error_raises(self):
        def failing(method, url, headers, body):
            return (500, "boom")

        with self.assertRaises(WriterError) as ctx:
            self.make(failing).write({"title": "作业", "date": "2026-11-19"})
        self.assertIn("HTTP_500", str(ctx.exception))

    def test_complete_upserts_daily_completion(self):
        transport = FakeTransport()
        result = self.make(transport).complete("task-1", "2026-11-19")
        self.assertEqual(result, {"task_id": "task-1", "date": "2026-11-19"})
        call = transport.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertIn("/todo_daily_completions", call["url"])
        self.assertIn("on_conflict=owner_id,task_id,completion_date", call["url"])
        self.assertIn("merge-duplicates", call["headers"]["Prefer"])
        row = json.loads(call["body"])[0]
        self.assertEqual(row["task_id"], "task-1")
        self.assertEqual(row["completion_date"], "2026-11-19")
        self.assertEqual(row["owner_id"], self.OWNER)
        self.assertTrue(row["completed"])

    def test_complete_rejects_bad_input(self):
        with self.assertRaises(WriterError):
            self.make(FakeTransport()).complete("", "2026-11-19")
        with self.assertRaises(WriterError):
            self.make(FakeTransport()).complete("task-1", "2026-02-30")


class PendingStoreTest(unittest.TestCase):
    def test_draft_lifecycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "agenda.db")
            try:
                first = store.add_pending("umo-1", "原句", '{"title":"a"}')
                second = store.add_pending("umo-1", "原句2", '{"title":"b"}')
                latest = store.latest_pending("umo-1")
                assert latest is not None
                self.assertEqual(latest["id"], second)
                self.assertEqual(json.loads(latest["payload"]), {"title": "b"})
                store.drop_pending(second)
                latest = store.latest_pending("umo-1")
                assert latest is not None
                self.assertEqual(latest["id"], first)
                store.clear_pending("umo-1")
                self.assertIsNone(store.latest_pending("umo-1"))
                self.assertIsNone(store.latest_pending("other"))
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
