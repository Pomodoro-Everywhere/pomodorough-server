from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import restore_drill


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "restore_drill.py"
USER_ID = "0123456789abcdef0123456789abcdef"


def write_json(path: Path, value: dict[str, object]) -> None:
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def account_digest() -> str:
    return hashlib.sha256(USER_ID.encode()).hexdigest()


def write_lifecycle(ledger: Path, generation: int, state: str) -> None:
    write_json(
        ledger / f"account-{account_digest()}.json",
        {"version": 1, "generation": generation, "state": state, "updatedAtMs": generation},
    )


def write_tombstone(ledger: Path, generation: int) -> None:
    write_json(
        ledger / f"{account_digest()}.json",
        {"version": 1, "deletedGeneration": generation, "deletedAtMs": generation},
    )


def create_account_database(data: Path, generation: int) -> Path:
    users = data / "users"
    users.mkdir(parents=True, exist_ok=True)
    path = users / f"{USER_ID}.sqlite"
    database = sqlite3.connect(path)
    try:
        database.execute(
            "CREATE TABLE account_metadata (singleton INTEGER PRIMARY KEY, generation INTEGER NOT NULL)"
        )
        database.execute("INSERT INTO account_metadata VALUES (1, ?)", (generation,))
        database.commit()
    finally:
        database.close()
    return path


def update_account_generation(data: Path, generation: int) -> None:
    database = sqlite3.connect(data / "users" / f"{USER_ID}.sqlite")
    try:
        database.execute("UPDATE account_metadata SET generation = ? WHERE singleton = 1", (generation,))
        database.commit()
    finally:
        database.close()


class RestoreDrillS2Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_script(self, *arguments: Path | str, success: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["python3", str(SCRIPT), *(str(argument) for argument in arguments)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if success and result.returncode != 0:
            self.fail(f"command failed: {result.stderr}")
        if not success and result.returncode == 0:
            self.fail(f"command unexpectedly passed: {result.stdout}")
        return result

    def active_storage(self, name: str, generation: int = 2) -> tuple[Path, Path]:
        data, ledger = self.root / f"{name}-data", self.root / f"{name}-ledger"
        data.mkdir()
        ledger.mkdir()
        create_account_database(data, generation)
        write_lifecycle(ledger, generation, "active")
        return data, ledger

    def deleted_storage(self, name: str, generation: int = 2) -> tuple[Path, Path]:
        data, ledger = self.root / f"{name}-data", self.root / f"{name}-ledger"
        (data / "users").mkdir(parents=True)
        ledger.mkdir()
        write_lifecycle(ledger, generation, "deleted")
        write_tombstone(ledger, generation)
        return data, ledger

    def snapshot(self, name: str, data: Path, ledger: Path) -> Path:
        destination = self.root / name
        self.run_script("snapshot", data, ledger, destination)
        self.run_script("verify", destination)
        return destination

    def manifest_digest(self, snapshot: Path) -> str:
        return (snapshot / "manifest.sha256").read_text().split()[0]

    def continue_lineage(self, source_data: Path, source_ledger: Path, data: Path, ledger: Path) -> None:
        shutil.copy2(source_data / restore_drill.RECOVERY_BINDING_FILE, data / restore_drill.RECOVERY_BINDING_FILE)
        for source in source_ledger.iterdir():
            if restore_drill.LIFECYCLE_FILE.fullmatch(source.name) or restore_drill.TOMBSTONE_FILE.fullmatch(source.name):
                continue
            shutil.copy2(source, ledger / source.name)

    def restore(self, data_snapshot: Path, ledger_snapshot: Path, data: Path, ledger: Path, success: bool = True):
        return self.run_script(
            "restore",
            data_snapshot,
            ledger_snapshot,
            data,
            ledger,
            "--data-manifest-sha256",
            self.manifest_digest(data_snapshot),
            "--ledger-manifest-sha256",
            self.manifest_digest(ledger_snapshot),
            success=success,
        )

    def test_legacy_database_drill_remains_available(self) -> None:
        source, destination = self.root / "source.sqlite", self.root / "restored.sqlite"
        database = sqlite3.connect(source)
        database.execute("CREATE TABLE probe(value TEXT NOT NULL)")
        database.execute("INSERT INTO probe VALUES ('ready')")
        database.commit()
        database.close()
        self.run_script(source, destination)
        restored = sqlite3.connect(destination)
        try:
            self.assertEqual(restored.execute("SELECT value FROM probe").fetchone(), ("ready",))
        finally:
            restored.close()

    def test_snapshot_rejects_empty_stale_and_sidecar_only_ledgers(self) -> None:
        for name, prepare in {
            "empty": lambda ledger: None,
            "stale": lambda ledger: write_lifecycle(ledger, 1, "active"),
        }.items():
            with self.subTest(name=name):
                data, ledger = self.root / f"{name}-data", self.root / f"{name}-ledger"
                data.mkdir()
                ledger.mkdir()
                create_account_database(data, 2)
                prepare(ledger)
                result = self.run_script("snapshot", data, ledger, self.root / f"{name}-snapshot", success=False)
                self.assertIn("ledger", result.stderr)
        data, ledger = self.root / "sidecar-data", self.root / "sidecar-ledger"
        (data / "users").mkdir(parents=True)
        ledger.mkdir()
        write_lifecycle(ledger, 1, "active")
        (data / "users" / f"{USER_ID}.sqlite-wal").write_bytes(b"sidecar")
        result = self.run_script("snapshot", data, ledger, self.root / "sidecar-snapshot", success=False)
        self.assertIn("sidecar-only", result.stderr)

    def test_offline_enrollment_binds_authoritative_pre_lifecycle_storage(self) -> None:
        data, ledger = self.root / "enroll-data", self.root / "enroll-ledger"
        data.mkdir()
        ledger.mkdir()
        create_account_database(data, 2)
        write_tombstone(ledger, 1)
        self.run_script("enroll", data, ledger)
        lifecycle = json.loads((ledger / f"account-{account_digest()}.json").read_text())
        self.assertEqual((lifecycle["generation"], lifecycle["state"]), (2, "active"))
        self.run_script("enroll", data, ledger)
        self.snapshot("enrolled-snapshot", data, ledger)

        sidecar_data, sidecar_ledger = self.root / "enroll-sidecar-data", self.root / "enroll-sidecar-ledger"
        (sidecar_data / "users").mkdir(parents=True)
        sidecar_ledger.mkdir()
        (sidecar_data / "users" / f"{USER_ID}.sqlite-wal").write_bytes(b"sidecar")
        result = self.run_script("enroll", sidecar_data, sidecar_ledger, success=False)
        self.assertIn("sidecar-only", result.stderr)

    def test_restore_uses_newest_ledger_before_selected_account_data(self) -> None:
        old_data, old_ledger = self.active_storage("old")
        write_tombstone(old_ledger, 1)
        (old_ledger / "capture.receipt").write_text("fixed\n")
        old_snapshot = self.snapshot("old-snapshot", old_data, old_ledger)
        new_data, new_ledger = self.deleted_storage("new")
        self.continue_lineage(old_data, old_ledger, new_data, new_ledger)
        new_snapshot = self.snapshot("new-snapshot", new_data, new_ledger)
        destination_data, destination_ledger = self.root / "restored-data", self.root / "restored-ledger"
        original_rename, order = restore_drill.os.rename, []

        def recorded_rename(source: Path, target: Path) -> None:
            resolved_target = Path(target).resolve()
            if resolved_target in {destination_data.resolve(), destination_ledger.resolve()}:
                order.append(resolved_target)
            original_rename(source, target)

        with mock.patch("pathlib.os.rename", recorded_rename):
            restore_drill.restore_snapshot(
                old_snapshot,
                new_snapshot,
                destination_data,
                destination_ledger,
                self.manifest_digest(old_snapshot),
                self.manifest_digest(new_snapshot),
            )
        self.assertEqual(order, [destination_ledger.resolve(), destination_data.resolve()])
        self.assertTrue((destination_data / "users" / f"{USER_ID}.sqlite").is_file())
        tombstone = json.loads((destination_ledger / f"{account_digest()}.json").read_text())
        self.assertEqual(tombstone["deletedGeneration"], 2)

    def test_restore_rejects_ledger_rollback_and_inventory_loss(self) -> None:
        old_data, old_ledger = self.active_storage("old")
        write_tombstone(old_ledger, 1)
        (old_ledger / "capture.receipt").write_text("fixed\n")
        old_snapshot = self.snapshot("old-snapshot", old_data, old_ledger)
        new_data, new_ledger = self.deleted_storage("new")
        self.continue_lineage(old_data, old_ledger, new_data, new_ledger)
        new_snapshot = self.snapshot("new-snapshot", new_data, new_ledger)
        rollback = self.restore(
            new_snapshot, old_snapshot, self.root / "rollback-data", self.root / "rollback-ledger", success=False
        )
        self.assertIn("rolls back deletion watermark", rollback.stderr)
        missing_data, missing_ledger = self.active_storage("missing")
        write_tombstone(missing_ledger, 1)
        self.continue_lineage(old_data, old_ledger, missing_data, missing_ledger)
        (missing_ledger / "capture.receipt").unlink()
        missing_snapshot = self.snapshot("missing-snapshot", missing_data, missing_ledger)
        inventory = self.restore(
            old_snapshot,
            missing_snapshot,
            self.root / "inventory-data",
            self.root / "inventory-ledger",
            success=False,
        )
        self.assertIn("omits immutable inventory", inventory.stderr)

        digest = "0" * 64
        mismatch = self.run_script(
            "restore",
            old_snapshot,
            new_snapshot,
            self.root / "digest-data",
            self.root / "digest-ledger",
            "--data-manifest-sha256",
            digest,
            "--ledger-manifest-sha256",
            self.manifest_digest(new_snapshot),
            success=False,
        )
        self.assertIn("trusted manifest SHA-256 mismatch", mismatch.stderr)

    def test_snapshot_tampering_and_physical_alias_fail_closed(self) -> None:
        data, ledger = self.active_storage("tamper")
        snapshot = self.snapshot("tamper-snapshot", data, ledger)
        lifecycle = snapshot / "ledger" / f"account-{account_digest()}.json"
        lifecycle.write_text(lifecycle.read_text() + " ")
        result = self.run_script("verify", snapshot, success=False)
        self.assertIn("inventory mismatch", result.stderr)
        aliased_data = self.root / "aliased-data"
        nested_ledger = aliased_data / "ledger"
        nested_ledger.mkdir(parents=True)
        alias = self.root / "ledger-alias"
        alias.symlink_to(nested_ledger, target_is_directory=True)
        result = self.run_script("snapshot", aliased_data, alias, self.root / "alias-snapshot", success=False)
        self.assertIn("symbolic-link directory rejected", result.stderr)

        invalid_data, invalid_ledger = self.active_storage("invalid-ledger-name")
        write_json(invalid_ledger / "account-invalid.json", {"version": 1})
        result = self.run_script(
            "snapshot", invalid_data, invalid_ledger, self.root / "invalid-ledger-snapshot", success=False
        )
        self.assertIn("invalid account lifecycle filename", result.stderr)

    def test_snapshot_rejects_source_mutation_during_copy(self) -> None:
        data, ledger = self.active_storage("mutation")
        original_copy, copied = restore_drill.copy_inventory, []

        def copy_then_mutate(source: Path, destination: Path, entries: list[dict[str, object]]) -> None:
            original_copy(source, destination, entries)
            copied.append(source)
            if source == data.resolve():
                (data / "changed-after-copy").write_text("changed\n")

        with mock.patch.object(restore_drill, "copy_inventory", copy_then_mutate):
            with self.assertRaisesRegex(RuntimeError, "source storage changed"):
                restore_drill.create_snapshot(data, ledger, self.root / "mutation-snapshot")
        self.assertEqual(copied, [ledger.resolve(), data.resolve()])
        self.assertFalse((self.root / "mutation-snapshot").exists())

    def test_restore_rejects_snapshot_mutation_after_copy(self) -> None:
        data, ledger = self.active_storage("restore-mutation")
        snapshot = self.snapshot("restore-mutation-snapshot", data, ledger)
        original_copy = restore_drill.copy_inventory

        def copy_then_mutate(source: Path, destination: Path, entries: list[dict[str, object]]) -> None:
            original_copy(source, destination, entries)
            if source == (snapshot / "data").resolve():
                (source / "changed-after-copy").write_text("changed\n")

        with mock.patch.object(restore_drill, "copy_inventory", copy_then_mutate):
            with self.assertRaisesRegex(ValueError, "snapshot inventory changed during verification"):
                restore_drill.restore_snapshot(
                    snapshot,
                    snapshot,
                    self.root / "mutation-restored-data",
                    self.root / "mutation-restored-ledger",
                    self.manifest_digest(snapshot),
                    self.manifest_digest(snapshot),
                )
        self.assertFalse((self.root / "mutation-restored-data").exists())
        self.assertFalse((self.root / "mutation-restored-ledger").exists())

    def test_manifest_path_swap_never_parses_unauthenticated_bytes(self) -> None:
        data, ledger = self.active_storage("manifest-swap")
        snapshot = self.snapshot("manifest-swap-snapshot", data, ledger)
        manifest_path = snapshot / "manifest.json"
        replacement = snapshot / "replacement-manifest.json"
        malicious = json.loads(manifest_path.read_text())
        malicious["version"] = 999
        write_json(replacement, malicious)
        original_open, swapped = restore_drill.os.open, False
        resolved_manifest = manifest_path.resolve()

        def open_then_swap(path, flags, *args, **kwargs):
            nonlocal swapped
            descriptor = original_open(path, flags, *args, **kwargs)
            if Path(path).resolve() == resolved_manifest and not swapped:
                os.replace(replacement, manifest_path)
                swapped = True
            return descriptor

        with mock.patch.object(restore_drill.os, "open", open_then_swap):
            with self.assertRaisesRegex(ValueError, "manifest changed during verification"):
                restore_drill.verify_snapshot(snapshot, self.manifest_digest(snapshot))

    def test_copy_uses_authenticated_open_file_during_path_swap(self) -> None:
        source, destination = self.root / "copy-source", self.root / "copy-destination"
        source.mkdir()
        target = source / "record.json"
        original_contents = b'{"trusted":true}\n'
        target.write_bytes(original_contents)
        entries = restore_drill.inventory(source)
        replacement = self.root / "replacement.json"
        replacement.write_bytes(b'{"trusted":false}\n')
        original_open, swapped = restore_drill.os.open, False

        def open_then_swap(path, flags, *args, **kwargs):
            nonlocal swapped
            descriptor = original_open(path, flags, *args, **kwargs)
            if Path(path) == target and not swapped:
                os.replace(replacement, target)
                swapped = True
            return descriptor

        with mock.patch.object(restore_drill.os, "open", open_then_swap):
            restore_drill.copy_inventory(source, destination, entries)
        self.assertEqual((destination / target.name).read_bytes(), original_contents)

    def test_unrelated_valid_snapshot_transplant_is_rejected(self) -> None:
        first_data, first_ledger = self.active_storage("first-domain")
        second_data, second_ledger = self.active_storage("second-domain")
        first = self.snapshot("first-domain-snapshot", first_data, first_ledger)
        second = self.snapshot("second-domain-snapshot", second_data, second_ledger)
        result = self.restore(
            first, second, self.root / "transplant-data", self.root / "transplant-ledger", success=False
        )
        self.assertIn("different recovery domain", result.stderr)

    def test_same_domain_forked_sequence_transplant_is_rejected(self) -> None:
        data, ledger = self.active_storage("lineage-root")
        self.snapshot("lineage-root-snapshot", data, ledger)
        first_data, first_ledger = self.root / "first-fork-data", self.root / "first-fork-ledger"
        second_data, second_ledger = self.root / "second-fork-data", self.root / "second-fork-ledger"
        shutil.copytree(data, first_data)
        shutil.copytree(ledger, first_ledger)
        shutil.copytree(data, second_data)
        shutil.copytree(ledger, second_ledger)
        update_account_generation(first_data, 3)
        update_account_generation(second_data, 4)
        write_lifecycle(first_ledger, 3, "active")
        write_lifecycle(second_ledger, 4, "active")
        first = self.snapshot("first-fork-snapshot", first_data, first_ledger)
        second = self.snapshot("second-fork-snapshot", second_data, second_ledger)
        result = self.restore(
            first, second, self.root / "fork-data", self.root / "fork-ledger", success=False
        )
        self.assertIn("omits immutable inventory", result.stderr)

    def test_snapshot_recovers_after_receipt_publish_crash(self) -> None:
        data, ledger = self.active_storage("receipt-crash")
        with mock.patch.object(restore_drill, "write_recovery_binding", side_effect=RuntimeError("crash")):
            with self.assertRaisesRegex(RuntimeError, "crash"):
                restore_drill.create_snapshot(data, ledger, self.root / "crashed-snapshot")
        self.assertFalse((data / restore_drill.RECOVERY_BINDING_FILE).exists())
        self.assertTrue((ledger / ".recovery-receipt-0000000000000001.json").exists())
        (data / ".pending-recovery-crash").write_bytes(b"partial")
        (ledger / ".pending-recovery-crash").write_bytes(b"partial")
        snapshot = self.snapshot("recovered-snapshot", data, ledger)
        binding = json.loads((snapshot / "data" / restore_drill.RECOVERY_BINDING_FILE).read_text())
        self.assertEqual(binding["sequence"], 2)
        self.assertFalse((snapshot / "data" / ".pending-recovery-crash").exists())
        self.assertFalse((snapshot / "ledger" / ".pending-recovery-crash").exists())


if __name__ == "__main__":
    unittest.main()
