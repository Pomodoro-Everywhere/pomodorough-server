#!/usr/bin/env python3
"""Generate browser metadata from the pinned shared-core artifact."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHARED = ROOT / "internal" / "sharedcore"
OUTPUT = ROOT / "web" / "shared-core-metadata.js"


def rendered_metadata() -> str:
    wasm = SHARED / "pomodorough_core.wasm"
    digest = hashlib.sha256(wasm.read_bytes()).hexdigest()
    pin = (SHARED / "pomodorough_core.wasm.sha256").read_text(encoding="ascii").split()[0]
    commit = (SHARED / "CORE_COMMIT").read_text(encoding="ascii").strip()
    if digest != pin:
        raise SystemExit(f"pinned WASM digest mismatch: metadata={pin} artifact={digest}")
    if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit):
        raise SystemExit("CORE_COMMIT is not a lowercase Git object ID")
    return f'''"use strict";

(function (root, factory) {{
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
}})(typeof globalThis !== "undefined" ? globalThis : this, function () {{
  const sha256 = "{digest}";
  return Object.freeze({{
    coreCommit: "{commit}",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${{sha256}}`,
    cacheVersion: `core-${{sha256.slice(0, 16)}}`
  }});
}});
'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = rendered_metadata()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != expected:
            raise SystemExit("web/shared-core-metadata.js is stale; run this script without --check")
        return
    OUTPUT.write_text(expected, encoding="utf-8")


if __name__ == "__main__":
    main()
