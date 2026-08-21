#!/usr/bin/env python3
"""Fail CI when a repository-relative Markdown link points to a missing path."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
IGNORED_PREFIXES = ("http://", "https://", "mailto:", "#", "data:")
IGNORED_PARTS = {".git", "node_modules", "dist", "build"}


def markdown_files(root: Path):
    for path in root.rglob("*.md"):
        if not any(part in IGNORED_PARTS for part in path.relative_to(root).parts):
            yield path


def link_target(raw: str) -> str:
    target = raw.strip()
    if target.startswith("<") and ">" in target:
        target = target[1 : target.index(">")]
    elif " " in target:
        target = target.split(" ", 1)[0]
    return unquote(target.split("#", 1)[0])


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    failures: list[str] = []
    checked = 0
    for document in markdown_files(root):
        text = document.read_text(encoding="utf-8")
        for match in LINK.finditer(text):
            raw = match.group(1)
            if raw.startswith(IGNORED_PREFIXES):
                continue
            target = link_target(raw)
            if not target:
                continue
            checked += 1
            resolved = (document.parent / target).resolve()
            try:
                resolved.relative_to(root)
            except ValueError:
                failures.append(f"{document.relative_to(root)}: link escapes repository: {raw}")
                continue
            if not resolved.exists():
                line = text.count("\n", 0, match.start()) + 1
                failures.append(f"{document.relative_to(root)}:{line}: missing link target: {raw}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"documentation links ok ({checked} relative links checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
