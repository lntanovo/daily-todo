"""Chat-set daily brief: intent parsing and schedule helpers.

The owner should be able to say things like:

    每天 9 点提醒我最近有什么任务
    每天晚上八点给我发任务清单
    取消每天提醒

This module turns those sentences into a small intent object. It stays pure so
the phrasings can be unit tested without AstrBot.

Design note: the clock only counts when the sentence is clearly about a daily
brief (``每天/每日/天天`` + a reminder verb), so an ordinary schedule message
like "周五 23:59 交作业" is never mistaken for a setting.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}
DAILY_WORDS = re.compile(r"(每天|每日|天天)")
REMIND_WORDS = re.compile(r"(提醒|通知|推送|发|告诉|简报|清单|汇总|安排)")
OFF_WORDS = re.compile(r"(取消|关闭|关掉|停止|不要|别|不用)")
PERIOD_WORDS = "凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间"
CLOCK_RE = re.compile(
    rf"(?:(?P<period>{PERIOD_WORDS})\s*)?"
    r"(?P<hour>\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:点|时|[:：])\s*"
    r"(?:(?P<minute>\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分?|(?P<fraction>半|一刻|三刻))?"
)
FRACTIONS = {"半": 30, "一刻": 15, "三刻": 45}


@dataclass
class DailyIntent:
    """What the owner asked about the daily brief.

    ``action`` is one of ``set`` / ``off`` / ``show`` / ``need_time``.
    """

    action: str
    time: str | None = None


def _number(token: str | None) -> int | None:
    """Parse an Arabic or simple Chinese numeral (一 … 二十三)."""
    if not token:
        return None
    if token.isdigit():
        return int(token)
    if token in CN_DIGITS:
        return CN_DIGITS[token]
    if token == "十":
        return 10
    if "十" in token:
        left, _, right = token.partition("十")
        tens = CN_DIGITS.get(left, 1) if left else 1
        ones = CN_DIGITS.get(right, 0) if right else 0
        return tens * 10 + ones
    return None


def parse_clock(text: str) -> str | None:
    """Extract a 24-hour ``HH:MM`` clock out of a sentence.

    Args:
        text: The owner's sentence.

    Returns:
        ``HH:MM`` or None when no usable clock is present.
    """
    match = CLOCK_RE.search(text or "")
    if match is None:
        return None
    hour = _number(match.group("hour"))
    minute = _number(match.group("minute"))
    if minute is None:
        minute = FRACTIONS.get(match.group("fraction") or "", 0)
    if hour is None or not 0 <= minute <= 59:
        return None
    period = match.group("period") or ""
    if period in {"晚上", "夜里", "夜间"} and hour == 12:
        hour = 0  # "晚上12点" 是午夜
    elif period in {"下午", "傍晚", "晚上", "夜里", "夜间"} and hour < 12:
        hour += 12
    elif period == "中午" and hour < 11:
        hour += 12
    elif period == "凌晨" and hour == 12:
        hour = 0
    if not 0 <= hour <= 23:
        return None
    return f"{hour:02d}:{minute:02d}"


def parse_daily_intent(text: str) -> DailyIntent | None:
    """Parse a daily-brief request, or None when the sentence is unrelated.

    Args:
        text: The owner's private message.

    Returns:
        A :class:`DailyIntent`, or None when this is not about the daily brief.
    """
    body = (text or "").strip()
    if not body:
        return None

    if DAILY_WORDS.search(body) and OFF_WORDS.search(body) and REMIND_WORDS.search(body):
        return DailyIntent("off")

    if not DAILY_WORDS.search(body) or not REMIND_WORDS.search(body):
        return None

    clock = parse_clock(body)
    if clock:
        return DailyIntent("set", clock)
    if re.search(r"(几点|什么时间|什么时候|设置|调整)", body):
        return DailyIntent("show")
    return DailyIntent("need_time")


def push_due(now: datetime, target: str, last_date: str) -> bool:
    """Whether the daily brief should go out at this tick.

    Args:
        now: Current time in Asia/Shanghai.
        target: Configured ``HH:MM``; empty when the brief is off.
        last_date: ``YYYY-MM-DD`` of the last delivery.

    Returns:
        True at the first tick at/after the target that has not sent today.
        A missed day sends once after the machine comes back up.
    """
    if not target or not re.fullmatch(r"\d{2}:\d{2}", target):
        return False
    today = now.strftime("%Y-%m-%d")
    return now.strftime("%H:%M") >= target and last_date != today
