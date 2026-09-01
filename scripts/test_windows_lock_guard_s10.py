#!/usr/bin/env python3
"""Regression checks for Windows data-directory lock build coverage."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CI = ROOT / ".github" / "workflows" / "ci.yml"
RELEASE = ROOT / ".github" / "workflows" / "release.yml"


def missing_guard_tokens(ci: str, release: str) -> list[str]:
    required = {
        "CI Windows target": (ci, "GOOS: windows"),
        "CI store test compile": (ci, 'go test -c -o "$RUNNER_TEMP/store.test.exe" ./internal/store'),
        "CI server cross-build": (ci, 'go build -o "$RUNNER_TEMP/pomodorough.exe" ./cmd/pomodorough'),
        "release Windows target": (release, "GOOS: windows"),
        "release store test compile": (release, 'go test -c -o "$RUNNER_TEMP/store.test.exe" ./internal/store'),
        "release server cross-build": (release, 'go build -o "$RUNNER_TEMP/pomodorough.exe" ./cmd/pomodorough'),
        "Windows runtime lock test": (release, "go test ./internal/store -run '^TestDataDirLock'"),
    }
    return [name for name, (text, token) in required.items() if text.count(token) != 1]


class WindowsLockBuildGuardTests(unittest.TestCase):
    def test_workflows_compile_windows_and_run_lock_test(self) -> None:
        ci = CI.read_text(encoding="utf-8")
        release = RELEASE.read_text(encoding="utf-8")
        self.assertEqual(missing_guard_tokens(ci, release), [])

    def test_each_required_guard_is_independently_enforced(self) -> None:
        ci = CI.read_text(encoding="utf-8")
        release = RELEASE.read_text(encoding="utf-8")
        for source, token in (
            ("ci", "GOOS: windows"),
            ("ci", "go test -c"),
            ("ci", "go build -o"),
            ("release", "GOOS: windows"),
            ("release", "go test -c"),
            ("release", "go build -o"),
            ("release", "go test ./internal/store -run"),
        ):
            mutated_ci = ci.replace(token, "removed", 1) if source == "ci" else ci
            mutated_release = release.replace(token, "removed", 1) if source == "release" else release
            self.assertNotEqual(missing_guard_tokens(mutated_ci, mutated_release), [], token)


if __name__ == "__main__":
    unittest.main()
