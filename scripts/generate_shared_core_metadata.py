#!/usr/bin/env python3
"""Generate browser metadata from the pinned shared-core artifact."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHARED = ROOT / "internal" / "sharedcore"
WEB_OUTPUT = ROOT / "web" / "shared-core-metadata.js"
READINESS_OUTPUT = ROOT / "internal" / "server" / "readiness_core_metadata_generated.go"


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


def rendered_outputs() -> dict[Path, str]:
    metadata = rendered_metadata()
    metadata_digest = hashlib.sha256(metadata.encode("utf-8")).hexdigest()
    readiness_source = f'''package server

const readinessSharedCoreMetadataDigest = "{metadata_digest}"
'''
    return {WEB_OUTPUT: metadata, READINESS_OUTPUT: readiness_source}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    outputs = rendered_outputs()
    if args.check:
        stale = [
            str(path.relative_to(ROOT))
            for path, expected in outputs.items()
            if not path.exists() or path.read_text(encoding="utf-8") != expected
        ]
        if stale:
            raise SystemExit(f"generated shared-core metadata is stale: {', '.join(stale)}")
        return
    for path, expected in outputs.items():
        path.write_text(expected, encoding="utf-8")


if __name__ == "__main__":
    main()
