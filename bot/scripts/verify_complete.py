"""Verify that marking a task done against the real cloud works, then clean up.

只做一次"插入 → 读回 → 删除"的往返，用 2026-01-01 这个过去的日期，
不会影响站点上任何一天的显示。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from astrbot_plugin_agenda.cloud_reader import CloudReader  # noqa: E402
from astrbot_plugin_agenda.cloud_writer import CloudWriter  # noqa: E402

CONFIG = ROOT / "astrbot" / "data" / "config" / "astrbot_plugin_agenda_config.json"
PROBE_DAY = "2026-01-01"


def main() -> int:
    conf = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    env_id = conf["cloud_env_id"]
    api_key = conf["cloud_api_key"]
    owner = conf["owner_id"]

    reader = CloudReader(env_id, api_key, owner)
    tasks = reader._get(
        f"/todo_tasks?owner_id=eq.{owner}&deleted_at=is.null&select=id,title,task_date&limit=3"
    )
    if not tasks:
        print("没有可用的任务，跳过")
        return 1
    task = tasks[0]
    print(f"挑一条任务：{task['title']} ({task['id'][:8]}…)")

    writer = CloudWriter(env_id, api_key, owner)
    result = writer.complete(task["id"], PROBE_DAY)
    print("complete() 返回：", result)

    rows = reader._get(
        f"/todo_daily_completions?owner_id=eq.{owner}&task_id=eq.{task['id']}"
        f"&completion_date=eq.{PROBE_DAY}&select=task_id,completion_date,completed"
    )
    print("读回：", rows)
    if not rows or rows[0].get("completed") is not True:
        print("FAIL: 云端没有读到 completed=true")
        return 1

    writer._call(
        "DELETE",
        f"/todo_daily_completions?owner_id=eq.{owner}&task_id=eq.{task['id']}"
        f"&completion_date=eq.{PROBE_DAY}",
    )
    left = reader._get(
        f"/todo_daily_completions?owner_id=eq.{owner}&task_id=eq.{task['id']}"
        f"&completion_date=eq.{PROBE_DAY}&select=task_id"
    )
    print("清理后剩余：", left)
    print("OK" if not left else "FAIL: 探针行没删掉")
    return 0 if not left else 1


if __name__ == "__main__":
    raise SystemExit(main())
