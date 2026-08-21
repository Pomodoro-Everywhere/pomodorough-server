#!/usr/bin/env python3
"""Create and verify an isolated SQLite restore-drill copy without mutating source data."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="live or copied user SQLite database")
    parser.add_argument("destination", type=Path, help="new restore-drill database path")
    args = parser.parse_args()

    source = args.source.expanduser().resolve(strict=True)
    destination = args.destination.expanduser().resolve()
    if source == destination:
        parser.error("destination must differ from source")
    if destination.exists():
        parser.error("destination already exists; refusing to overwrite it")
    destination.parent.mkdir(parents=True, exist_ok=True)

    source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    restored_db = sqlite3.connect(destination)
    try:
        source_db.backup(restored_db)
        result = restored_db.execute("PRAGMA integrity_check").fetchone()
        if result != ("ok",):
            raise RuntimeError(f"restored integrity check failed: {result!r}")
        table_count = restored_db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchone()[0]
    finally:
        restored_db.close()
        source_db.close()

    print(f"restore drill passed: {destination} ({table_count} application tables)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
