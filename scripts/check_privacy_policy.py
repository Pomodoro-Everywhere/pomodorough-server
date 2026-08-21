#!/usr/bin/env python3
"""Keep the deployed and public GitHub Pages privacy policies aligned."""
from __future__ import annotations

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLICIES = (ROOT / "web/privacy.html", ROOT / "docs/privacy/index.html")


class ArticleText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "article" or self.depth:
            self.depth += 1

    def handle_endtag(self, tag: str) -> None:
        if self.depth:
            self.depth -= 1

    def handle_data(self, data: str) -> None:
        if self.depth:
            self.parts.append(data)


def article_text(path: Path) -> str:
    parser = ArticleText()
    parser.feed(path.read_text(encoding="utf-8"))
    text = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()
    if not text:
        raise ValueError(f"{path.relative_to(ROOT)} has no article content")
    return text


def main() -> int:
    try:
        deployed, public = (article_text(path) for path in POLICIES)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    if deployed != public:
        print("web and GitHub Pages privacy policy content differs", file=sys.stderr)
        return 1
    print("privacy policy copies are aligned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
