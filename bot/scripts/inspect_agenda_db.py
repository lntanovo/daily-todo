"""Ad-hoc inspector for the plugin SQLite store (read-only)."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

DEFAULT = str(
    Path(__file__).resolve().parent.parent
    / "astrbot/data/plugin_data/astrbot_plugin_agenda/agenda.db"
)


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
    for table in tables:
        count = con.execute(f"select count(*) from {table}").fetchone()[0]
        print(f"== {table} ({count})")
        for row in con.execute(f"select * from {table} order by rowid desc limit 12"):
            print("   ", dict(row))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
