"""私聊捕获流水线：切分 → 编号 → 抽取 → 覆盖校验 → 草稿 / 确认选择。

为什么要有这一层（设计笔记，别删）：

1. 旧实现只问模型"这一件事是什么"，输出 schema 是单个 ``item``。
   一条私聊里就算有四件事，模型再聪明也只能交回一条——这是**结构性问题**，
   不是"模型智力"问题。
2. 切分不交给模型。用编号段 ``[S1]..[Sn]`` 把"必须逐段回答"变成代码可校验的
   硬约束：模型少答一段，``missing_segments()`` 当场发现，再问一次补抽。
3. "闲聊还是日程"用规则 + 模型双保险：模型给 ``kind``，代码用"有没有带时间的
   段落"和"有没有任务动词"兜底，两边冲突时宁可信规则的、宁可多问一句。
4. 本模块不 import AstrBot，纯函数，方便单测。
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date as date_cls
from datetime import datetime, timedelta, timezone

from .extractor import extract_json_block

CST = timezone(timedelta(hours=8))

# 私聊里用来确认/放弃草稿的词。只认短回复，避免把正文误当成指令。
CONFIRM_WORDS = {"1", "确认", "确定", "好", "好的", "记下", "保存", "对", "ok", "OK"}
CANCEL_WORDS = {"2", "取消", "不要", "算了", "删掉", "不记"}
ALL_WORDS = {"全部", "全存", "全要", "都存", "都要", "全记"}
RETRY_WORDS = {"重试", "再试", "再试一次", "重新解析"}

KINDS = ("deadline", "event", "task")

CAPTURE_SYSTEM_PROMPT = """你是一个日程抽取器。用户会发来一段话：可能只有一件事，可能是一份包含多件事的通知，也可能只是闲聊。

第一步：判断类型 kind
- schedule：用户在说自己要做的事、要参加的活动、某个截止时间
- chat：闲聊、吐槽、提问、情绪表达，没有要他记住的安排
- mixed：既有安排也有闲聊

第二步：逐条抽取 items
- 用户消息里会把"必须逐段回答"的内容编号成 [S1] [S2] ……。
- 每一个编号都必须产出一条结果，seg 原样填该编号。
- 如果某段其实是闲聊、吐槽、情绪、或者只是通知的客套话，就输出 {"seg":"S1","skip":true}，不要编一个题目出来。
- 一段里其实有两件事，就输出两条，seg 相同。
- 编号之外如果还有别的安排（例如"另外周五交报告"），再补一条，seg 填 "extra"。
- 没有给编号时，自己判断要不要记：是安排就抽，是闲聊天就返回空。

时间规则
1. date 用 YYYY-MM-DD。要按"今天"换算："明天""周五""下周三""12月1日"都算成具体日期。
2. time 用 HH:MM。只有"上午/中午/下午/晚上"没有具体钟点的，按 09:00 / 12:00 / 15:00 / 20:00 推断，confidence 给 0.6 以下。
3. 只有日期没有时刻，time 填 null；说不出日期，date 填 null。绝不编造日期。
4. kind 三选一：deadline（截止类：交作业、报名截止）、event（到点发生：讲座、培训、会议）、task（其他待办）。
5. title 20 字内，说清"什么事"，不要带"提醒""记得"，不要带编号。

只输出 JSON，不要解释、不要 markdown 代码块：
{"kind":"schedule","items":[{"seg":"S1","title":"","date":"2026-11-17","time":"16:30","kind":"event","confidence":0.9}]}
某段是闲聊：{"seg":"S1","skip":true}
没有任何安排时：{"kind":"chat","items":[]}"""

REPAIR_HINT = (
    "补充要求：这是一次补抽。上一次有编号被漏掉了，"
    "这一次只需要为下面给出的编号各输出一条 item，不要输出别的内容。"
)

_LIST_MARKER = re.compile(
    r"^\s*(?:"
    r"\d{1,2}\s*[、.．)）]"
    r"|[（(]\s*\d{1,2}\s*[)）]"
    r"|[一二三四五六七八九十]{1,3}\s*[、.．]"
    r"|[①-⑳]"
    r"|[-*•·]\s"
    r")"
)

_DATE_PATTERNS = (
    re.compile(r"\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*[日号]?"),
    re.compile(r"\d{1,2}\s*月\s*\d{1,2}\s*[日号]"),
    re.compile(r"(?:上上|下下|上|下|本|这)?(?:周|星期|礼拜)[一二三四五六日天]"),
    re.compile(r"今天|今晚|明天|明晚|后天|大后天|昨天|前天|周末|下周"),
)

_TIME_PATTERNS = (
    re.compile(r"\d{1,2}\s*[:：]\s*\d{2}"),
    re.compile(r"\d{1,2}\s*点(?:\s*\d{1,2}\s*分?|半|一刻|三刻)?"),
)

_TASK_CUES = re.compile(
    r"截止|ddl|DDL|Ddl|交作业|提交|报名|开会|面试|体检|打卡|考试|报名截止"
)
_TASK_LEADS = re.compile(r"^(?:记得|提醒我|别忘了|别忘|要记得)")
_LABEL_NOISE = re.compile(r"(?:时间|日期|地点|主讲人|主题|内容|备注|老师)\s*[:：]?")
_LEAD_NOISE = re.compile(
    r"^\s*(?:\d{1,2}\s*[、.．)）]|[（(]\s*\d{1,2}\s*[)）]|[①-⑳]|[-*•·])\s*"
)
_TITLE_NOISE = re.compile(r"^(?:提醒我|记得|别忘了|别忘|请|麻烦你?)\s*")


def fold(text: str) -> str:
    """把全角数字/字母/标点折成半角，用于正则匹配（展示仍用原文）。"""
    return unicodedata.normalize("NFKC", text or "")


def _cues(patterns, text: str) -> list[str]:
    hits: list[str] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            value = match.group(0).strip()
            if value and value not in hits:
                hits.append(value)
    return hits


def _content_len(text: str) -> int:
    """去掉日期/时刻线索和"时间：""地点："这类标签之后，还剩多少有意义的字符。"""
    stripped = text
    for pattern in _DATE_PATTERNS + _TIME_PATTERNS:
        stripped = pattern.sub("", stripped)
    stripped = _LABEL_NOISE.sub("", stripped)
    return len([ch for ch in stripped if unicodedata.category(ch)[0] in {"L", "N"}])


@dataclass
class Segment:
    """用户消息里的一块内容（一段话或一个列表项）。"""

    sid: str
    text: str
    dates: list[str] = field(default_factory=list)
    times: list[str] = field(default_factory=list)

    @property
    def has_when(self) -> bool:
        """这一段里是否出现了日期或时刻。"""
        return bool(self.dates or self.times)

    @property
    def summary(self) -> str:
        """单行摘要，用来在回复里提一句"还有这段没抽出来"。"""
        body = re.sub(r"\s*\n\s*", " / ", self.text.strip())
        body = re.sub(r"^\[\w+\]\s*", "", body)
        return body[:40] + ("…" if len(body) > 40 else "")


@dataclass
class CaptureItem:
    """一条解析出来的日程。"""

    title: str
    date: str | None = None
    time: str | None = None
    kind: str = "task"
    seg: str | None = None
    confidence: float = 0.0
    skipped: bool = False

    def as_dict(self) -> dict:
        """序列化成存进 ``pending.payload`` 的形状。"""
        return {
            "title": self.title,
            "date": self.date,
            "time": self.time,
            "kind": self.kind,
            "seg": self.seg,
            "confidence": round(self.confidence, 2),
        }


@dataclass
class CaptureResult:
    """一次私聊捕获的完整结果。"""

    kind: str = "chat"
    items: list[CaptureItem] = field(default_factory=list)
    segments: list[Segment] = field(default_factory=list)
    missing: list[Segment] = field(default_factory=list)
    error: str | None = None

    @property
    def has_schedule(self) -> bool:
        """模型抽到了条目，或者原文里本来就有带时间的段落。"""
        return bool(self.items) or bool(self.segments)


# ------------------------------------------------------------------ 切分


def _split_blocks(text: str) -> list[str]:
    """按空行 / 列表标记把消息切成块。"""
    blocks: list[str] = []
    current: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = line.rstrip()
        if not stripped.strip():
            if current:
                blocks.append("\n".join(current))
                current = []
            continue
        if _LIST_MARKER.match(stripped) and current:
            # 新的列表项：上一项结束；如果上一项是纯正文，也让它单独成块
            blocks.append("\n".join(current))
            current = [stripped]
            continue
        current.append(stripped)
    if current:
        blocks.append("\n".join(current))
    return blocks


def segment_message(text: str, *, max_segments: int = 12) -> list[Segment]:
    """把私聊切成"必须逐段回答"的编号段。

    只有同时满足"带日期/时刻"和"去掉时间线索后还有实质内容"的块才会被编号；
    没时间的段落（通知开头、群规、寒暄）留给模型当上下文。

    Args:
        text: 私聊原文。
        max_segments: 最多编号多少段，防止一条消息撑爆 prompt。

    Returns:
        编号段列表；没有任何带时间的段落时返回空列表。
    """
    blocks = [block for block in _split_blocks(text) if block.strip()]
    segments: list[Segment] = []
    for block in blocks:
        body = re.sub(r"[ \t]+", " ", block).strip()
        if not body:
            continue
        dates = _cues(_DATE_PATTERNS, fold(body))
        times = _cues(_TIME_PATTERNS, fold(body))
        if (dates or times) and _content_len(body) <= 1 and segments:
            # "时间：11月17日 16:30" 单独成块时，往上并到标题里
            segments[-1].text = f"{segments[-1].text}\n{body}"
            segments[-1].dates = _cues(_DATE_PATTERNS, fold(segments[-1].text))
            segments[-1].times = _cues(_TIME_PATTERNS, fold(segments[-1].text))
            continue
        segments.append(Segment(sid="", text=body, dates=dates, times=times))

    keep = [seg for seg in segments if seg.has_when and _content_len(seg.text) >= 2]
    for index, seg in enumerate(keep[:max_segments], 1):
        seg.sid = f"S{index}"
    return keep[:max_segments]


def context_text(text: str, segments: list[Segment], *, limit: int = 300) -> str:
    """把没被编号的段落压成一小段背景，给模型理解上下文用。"""
    numbered = [re.sub(r"\s+", " ", seg.text) for seg in segments]
    leftovers: list[str] = []
    for block in _split_blocks(text):
        body = re.sub(r"\s+", " ", block).strip()
        if not body:
            continue
        if any(body in seg_text for seg_text in numbered):
            continue
        leftovers.append(body)
    joined = " ".join(leftovers).strip()
    if len(joined) > limit:
        joined = joined[:limit] + "…"
    return joined


def _format_segment(seg: Segment) -> str:
    lines = [line.strip() for line in seg.text.split("\n") if line.strip()]
    if not lines:
        return f"[{seg.sid}]"
    head = f"[{seg.sid}] {lines[0]}"
    tail = [f"  {line}" for line in lines[1:]]
    return "\n".join([head, *tail])


def build_capture_prompt(
    text: str,
    segments: list[Segment] | None = None,
    *,
    now: datetime | None = None,
    repair: bool = False,
    context_limit: int = 300,
) -> str:
    """拼一次捕获用的 user prompt。

    Args:
        text: 私聊原文。
        segments: ``segment_message()`` 的结果；空表示"整条消息交给模型判断"。
        now: 参考时间，默认当前 UTC+8。
        repair: 是否补抽（只给漏掉的编号）。
        context_limit: 背景段落截断长度。

    Returns:
        发给模型的 user prompt。
    """
    now = now or datetime.now(CST)
    weekday = "一二三四五六日"[now.weekday()]
    lines = [
        f"今天是 {now:%Y-%m-%d} {now:%H:%M}（周{weekday}），时区 Asia/Shanghai。",
    ]

    if segments:
        head = "这是补抽。" if repair else ""
        lines.append(
            f"{head}下面 {len(segments)} 段是原文里带日期或时刻的内容，"
            f"每段都要输出一条 item："
        )
        for seg in segments:
            lines.append(_format_segment(seg))
        background = context_text(text, segments, limit=context_limit)
        if background:
            lines.append("")
            lines.append("原文里其余内容（不含具体时间，仅供参考）：")
            lines.append(background)
    else:
        body = text.strip()
        if len(body) > 1500:
            body = body[:1500] + "…"
        lines.append("用户说：")
        lines.append(body)
        lines.append("判断这是安排还是闲聊；是安排就抽出来，日期听不出来就填 null。")

    lines.append("")
    lines.append("请按系统提示的 JSON 格式输出，只输出 JSON。")
    return "\n".join(lines)


# ------------------------------------------------------------------ 解析


def _valid_date(value: object) -> str | None:
    text = str(value or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return None
    try:
        return text if date_cls.fromisoformat(text).isoformat() == text else None
    except ValueError:
        return None


def _valid_time(value: object) -> str | None:
    text = fold(str(value or "")).strip()
    return text if re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", text) else None


def clean_title(value: object) -> str:
    """去掉编号、口头语和多余标点。"""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = _LEAD_NOISE.sub("", text)
    text = _TITLE_NOISE.sub("", text)
    text = re.sub(r"[，。、；;,.]$", "", text).strip()
    return text[:60]


def _raw_items(payload: dict) -> list:
    """兼容模型可能用的几种键名。"""
    for key in ("items", "events", "list", "tasks"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    single = payload.get("item")
    return [single] if isinstance(single, dict) else []


def parse_capture_reply(raw: str) -> tuple[str, list[CaptureItem]]:
    """把模型的回复解析成 ``(kind, items)``。

    Args:
        raw: 模型原始输出，允许被 markdown 代码块包着。

    Returns:
        模型给出的 kind（可能是空串）和条目列表。字段不合法的条目**保留**
        但对应字段置空，这样覆盖校验仍然算它"答过了"。

    Raises:
        ValueError: 回复里根本没有 JSON。
    """
    payload = json.loads(extract_json_block(raw))
    if not isinstance(payload, dict):
        raise ValueError("top level JSON must be an object")

    kind = str(payload.get("kind") or "").strip().lower()
    if kind not in {"schedule", "chat", "mixed"}:
        kind = ""

    items: list[CaptureItem] = []
    for entry in _raw_items(payload):
        if not isinstance(entry, dict):
            continue
        seg = str(entry.get("seg") or entry.get("segment") or "").strip()
        seg = seg.upper() if seg else None
        if seg and re.fullmatch(r"\d{1,2}", seg):
            seg = f"S{seg}"
        title = clean_title(entry.get("title") or entry.get("name") or "")
        if not title:
            # 模型用 skip 或者干脆没给题目：算这段"答过了、但没有事"，
            # 覆盖校验放行，草稿里也不会出现空条目。
            if seg or entry.get("skip"):
                items.append(CaptureItem(title="", seg=seg, skipped=True))
            continue
        item_kind = str(entry.get("kind") or entry.get("type") or "task").strip().lower()
        if item_kind not in KINDS:
            item_kind = "task"
        try:
            confidence = float(entry.get("confidence") or 0.0)
        except (TypeError, ValueError):
            confidence = 0.0
        items.append(
            CaptureItem(
                title=title,
                date=_valid_date(entry.get("date")),
                time=_valid_time(entry.get("time")),
                kind=item_kind,
                seg=seg,
                confidence=max(0.0, min(1.0, confidence)),
                skipped=bool(entry.get("skip")),
            )
        )
    return kind, items


def _key(item: CaptureItem) -> tuple:
    return (item.seg, item.title, item.date, item.time)


def merge_items(base: list[CaptureItem], extra: list[CaptureItem]) -> list[CaptureItem]:
    """把补抽结果并进来：同编号、同内容都不重复添加。"""
    merged = list(base)
    covered = {item.seg for item in merged if item.seg and item.seg != "extra"}
    seen = {_key(item) for item in merged}
    for item in extra:
        if item.seg and item.seg not in {"extra"} and item.seg in covered:
            continue
        if _key(item) in seen:
            continue
        merged.append(item)
        seen.add(_key(item))
        if item.seg:
            covered.add(item.seg)
    return merged


def missing_segments(segments: list[Segment], items: list[CaptureItem]) -> list[Segment]:
    """哪些编号段一条 item 都没交上来。"""
    answered = {item.seg for item in items if item.seg}
    return [seg for seg in segments if seg.has_when and seg.sid not in answered]


def looks_like_task(text: str) -> bool:
    """规则兜底：像任务但没日期的句子，别让它悄悄流去闲聊。"""
    body = (text or "").strip()
    if not body:
        return False
    return bool(_TASK_CUES.search(body) or _TASK_LEADS.match(body))


# ------------------------------------------------------------------ 草稿 / 确认


def _fmt_when(item: dict) -> str:
    when = str(item.get("date") or "").strip()
    clock = str(item.get("time") or "").strip()
    if not when:
        return "日期没听清"
    label = when
    try:
        label += f"（周{'一二三四五六日'[date_cls.fromisoformat(when).weekday()]}）"
    except ValueError:
        pass
    if clock:
        return f"{label} {clock}"
    return f"{label}（没说几点，当天 20:00 提醒）"


def items_payload(
    items: list[CaptureItem],
    *,
    raw: str = "",
    kind: str = "schedule",
    missing: list[Segment] | None = None,
) -> dict:
    """组装存进 ``pending.payload`` 的 v2 结构。"""
    return {
        "v": 2,
        "kind": kind,
        "raw": raw,
        "items": [
            item.as_dict()
            for item in items
            if not item.skipped and item.title
        ],
        "missing": [seg.summary for seg in (missing or [])],
    }


def payload_items(payload: dict) -> list[dict]:
    """读出草稿里的条目；兼容 v1 的单条结构。"""
    if not isinstance(payload, dict):
        return []
    items = payload.get("items")
    if isinstance(items, list):
        return [item for item in items if isinstance(item, dict)]
    if payload.get("title"):
        return [payload]
    return []


def render_draft(payload: dict) -> str:
    """把草稿渲染成私聊里的确认文案。"""
    items = payload_items(payload)
    missing = [str(x) for x in (payload.get("missing") or [])]

    if not items:
        if missing:
            return (
                f"这段里有 {len(missing)} 处时间，但我一条都没抽准。\n"
                "你可以分批发，或者直接说「周五 16:30 党校培训」这种带时间的句子。"
            )
        return "这条我先没记下来。"

    if len(items) == 1 and not missing:
        item = items[0]
        return "\n".join(
            [
                "先跟你对一下：",
                f"· {item.get('title') or ''}",
                f"· {_fmt_when(item)}",
                "回「1」存进日程，回「2」不要；想改就再说一句。",
            ]
        )

    lines = [f"先跟你对一下，这次一共 {len(items)} 条："]
    for index, item in enumerate(items, 1):
        lines.append(f"{index}. {item.get('title') or ''}")
        lines.append(f"   {_fmt_when(item)}")
    if missing:
        lines.append(f"（原文里还有 {len(missing)} 段我没抽出准确时间，先没算进去：")
        for summary in missing:
            lines.append(f"  · {summary}")
        lines.append("  补一句「X 是几号几点」我再加。）")
    lines.append("回「1」全部存；只存其中几条就回「1 3」；回「2」全都不要。")
    return "\n".join(lines)


def parse_selection(
    text: str, count: int, *, ignore_commands: bool = False
) -> list[int] | None:
    """解析"只存其中几条"的回复。

    Args:
        text: 用户回复。
        count: 草稿里一共几条。
        ignore_commands: 真时不再把裸 ``1``/``2`` 当成确认/取消指令——
            追问"完成了吗"的场景里，``2`` 就是"第 2 项"。

    Returns:
        选中的 1-based 序号列表；无法判定时返回 None。
    """
    body = fold(text).strip()
    if count <= 0 or not body:
        return None
    if body in ALL_WORDS:
        return list(range(1, count + 1))
    if not ignore_commands and (body in CONFIRM_WORDS or body in CANCEL_WORDS):
        return None
    # 只允许"编号 + 少量连接词"，避免把新的一句话当成选择
    if not re.fullmatch(r"[\s0-9,，、;；+\-和跟以及要存记下第条个的全都只选就那这几]*", body):
        return None
    picks = sorted({int(x) for x in re.findall(r"\d{1,2}", body)})
    picks = [x for x in picks if 1 <= x <= count]
    return picks or None
