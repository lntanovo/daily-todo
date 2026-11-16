"""Benchmark the capture prompt against the real provider (read-only).

用法：
    python scripts/bench_capture.py [路径]

默认跑 tests/fixtures/training_notice.txt。会打印：
旧版单条 prompt 抽到几条（复现问题）
新版分段 prompt 抽到几条、漏了哪些段、补抽之后是否补齐
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from astrbot_plugin_agenda.capture import (  # noqa: E402
    CAPTURE_SYSTEM_PROMPT,
    REPAIR_HINT,
    build_capture_prompt,
    merge_items,
    missing_segments,
    parse_capture_reply,
    segment_message,
)

CONFIG = ROOT / "astrbot" / "data" / "cmd_config.json"
OLD_SYSTEM = """你是一个日程记录助手。用户会用一句话告诉你一件要做的事或一个安排。
只抽取"用户自己要做的事"或"确定的安排"，闲聊、提问、假设、否定一律返回 null。
只输出 JSON，不要 markdown：
{"item": {"title":"","date":null,"time":null,"kind":"task","confidence":0.0}}"""


def provider() -> tuple[str, str, str]:
    """(base_url, api_key, model) of the chat provider the bot actually uses."""
    cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    sources = {row["id"]: row for row in cfg.get("provider_sources", [])}
    for row in cfg.get("provider", []):
        source = sources.get(row.get("provider_source_id", ""))
        if source and row.get("id", "").endswith("deepseek-flash"):
            return source["api_base"].rstrip("/"), source["key"][0], row.get("model", "")
    raise SystemExit("找不到 deepseek-flash 提供商配置")


def ask(base: str, key: str, model: str, system: str, prompt: str) -> str:
    body = json.dumps(
        {
            "model": model,
            "temperature": 0,
            "max_tokens": 1500,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload["choices"][0]["message"]["content"]


CASES = [
    ("一句话一件事", "周五23:59交作业"),
    ("一句话三件事", "周三下午四点开会记得带电脑，周四上午十点面试，周五之前把实验报告交了"),
    ("闲聊", "今天好累啊，晚上不想动"),
    ("像任务但没日期", "记得给老师发邮件"),
    ("日程+闲聊混着", "这周事情好多。周二下午两点开组会，周五晚上七点聚餐，其他时间我想躺着"),
]


def run_case(base: str, key: str, model: str, name: str, text: str) -> None:
    """Run one message through the whole new pipeline and print a compact trace."""
    segments = segment_message(text)
    raw = ask(base, key, model, CAPTURE_SYSTEM_PROMPT, build_capture_prompt(text, segments))
    kind, items = parse_capture_reply(raw)
    missing = missing_segments(segments, items)
    if missing:
        raw2 = ask(
            base,
            key,
            model,
            f"{CAPTURE_SYSTEM_PROMPT}\n\n{REPAIR_HINT}",
            build_capture_prompt(text, missing, repair=True),
        )
        _, more = parse_capture_reply(raw2)
        items = merge_items(items, more)
        missing = missing_segments(segments, items)
    visible = [item for item in items if item.title and not item.skipped]
    print(f"-- {name}：{text}")
    print(
        f"   段={len(segments)} kind={kind} 条目={len(visible)} 漏={[s.sid for s in missing]}"
    )
    for item in visible:
        print(f"     {item.date} {item.time} {item.title} ({item.kind})")


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests" / "fixtures" / "training_notice.txt"
    text = path.read_text(encoding="utf-8")
    base, key, model = provider()
    print(f"模型：{model}  消息：{path.name}（{len(text)} 字）\n")

    old_prompt = f"用户说：{text}\n请按系统提示的 JSON 格式输出。"
    old = ask(base, key, model, OLD_SYSTEM, old_prompt)
    print("== 旧版（单条 item）")
    print(repr(old)[:800], "\n")

    segments = segment_message(text)
    print(f"切分结果：{len(segments)} 段")
    for seg in segments:
        print(f"  [{seg.sid}] {seg.dates} {seg.times} :: {seg.summary}")
    print()

    raw = ask(base, key, model, CAPTURE_SYSTEM_PROMPT, build_capture_prompt(text, segments))
    kind, items = parse_capture_reply(raw)
    missing = missing_segments(segments, items)
    print(f"== 新版（分段）kind={kind} 抽到 {len(items)} 条，漏 {[s.sid for s in missing]}")
    for item in items:
        print(f"  seg={item.seg} {item.date} {item.time} {item.title} ({item.kind}, {item.confidence})")

    if missing:
        raw2 = ask(
            base,
            key,
            model,
            f"{CAPTURE_SYSTEM_PROMPT}\n\n{REPAIR_HINT}",
            build_capture_prompt(text, missing, repair=True),
        )
        _, more = parse_capture_reply(raw2)
        items = merge_items(items, more)
        missing = missing_segments(segments, items)
        print(f"== 补抽之后：{len(items)} 条，漏 {[s.sid for s in missing]}")
        for item in more:
            print(f"  + seg={item.seg} {item.date} {item.time} {item.title}")

    print("\n== 其它场景")
    for name, case in CASES:
        try:
            run_case(base, key, model, name, case)
        except Exception as error:  # 单个 case 失败不影响其它
            print(f"-- {name}：调用失败 {error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
