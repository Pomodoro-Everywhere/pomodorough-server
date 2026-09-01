#!/usr/bin/env python3
"""Create, verify, and restore bound account-data and deletion-ledger snapshots."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

SNAPSHOT_VERSION = 2
MAX_SAFE_REVISION = 9_007_199_254_740_991
ACCOUNT_FILE = re.compile(r"^([0-9a-f]{32})\.sqlite(?:(-wal|-shm))?$")
LEDGER_DIGEST = r"([0-9a-f]{64})"
LIFECYCLE_FILE = re.compile(rf"^account-{LEDGER_DIGEST}\.json$")
TOMBSTONE_FILE = re.compile(rf"^{LEDGER_DIGEST}\.json$")
RECOVERY_DOMAIN_FILE = ".recovery-domain.json"
RECOVERY_BINDING_FILE = ".recovery-lineage.json"
RECOVERY_RECEIPT_FILE = re.compile(r"^\.recovery-receipt-([0-9]{16})\.json$")
RECOVERY_VERSION = 1
ZERO_DIGEST = "0" * 64
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


def open_regular(path: Path) -> tuple[int, os.stat_result]:
    descriptor = os.open(path, os.O_RDONLY | NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"regular file required: {path}")
        return descriptor, info
    except BaseException:
        os.close(descriptor)
        raise


def read_regular(path: Path, maximum: int | None = None) -> tuple[bytes, os.stat_result]:
    descriptor, info = open_regular(path)
    try:
        if maximum is not None and info.st_size > maximum:
            raise ValueError(f"file exceeds safe size: {path}")
        with os.fdopen(descriptor, "rb") as source:
            descriptor = -1
            contents = source.read(-1 if maximum is None else maximum + 1)
        if maximum is not None and len(contents) > maximum:
            raise ValueError(f"file exceeds safe size: {path}")
        return contents, info
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def sha256_file(path: Path) -> str:
    descriptor, _ = open_regular(path)
    digest = hashlib.sha256()
    with os.fdopen(descriptor, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def strict_json_bytes(contents: bytes, label: Path | str) -> dict[str, Any]:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"duplicate JSON key in {label}: {key}")
            value[key] = item
        return value

    value = json.loads(contents, object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise ValueError(f"JSON object required: {label}")
    return value


def strict_json(path: Path) -> dict[str, Any]:
    contents, _ = read_regular(path, 65_536)
    return strict_json_bytes(contents, path)


def secure_directory(path: Path) -> Path:
    if path.is_symlink():
        raise ValueError(f"symbolic-link directory rejected: {path}")
    resolved = path.expanduser().resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError(f"directory required: {path}")
    return resolved


def require_independent(first: Path, second: Path) -> None:
    first_resolved = first.expanduser().resolve()
    second_resolved = second.expanduser().resolve()
    if first_resolved == second_resolved or first_resolved in second_resolved.parents or second_resolved in first_resolved.parents:
        raise ValueError("data and deletion-ledger paths must be physically independent")


def inventory_file(path: Path, relative: str) -> dict[str, Any]:
    descriptor, info = open_regular(path)
    digest = hashlib.sha256()
    with os.fdopen(descriptor, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "path": relative,
        "mode": stat.S_IMODE(info.st_mode),
        "type": "file",
        "size": info.st_size,
        "sha256": digest.hexdigest(),
    }


def inventory(root: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    paths = sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix())
    for path in paths:
        info = path.lstat()
        relative = path.relative_to(root).as_posix()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError(f"unsupported snapshot entry: {path}")
        if stat.S_ISDIR(info.st_mode):
            entries.append({"path": relative, "mode": stat.S_IMODE(info.st_mode), "type": "directory"})
        elif stat.S_ISREG(info.st_mode):
            entries.append(inventory_file(path, relative))
        else:
            raise ValueError(f"unsupported snapshot entry: {path}")
    return entries


def valid_inventory_path(value: Any) -> bool:
    if not isinstance(value, str) or not value or value.startswith("/"):
        return False
    return all(part not in {"", ".", ".."} for part in value.split("/"))


def validate_inventory(entries: Any) -> list[dict[str, Any]]:
    if not isinstance(entries, list):
        raise ValueError("snapshot inventory must be a list")
    previous = ""
    for entry in entries:
        if not isinstance(entry, dict) or not valid_inventory_path(entry.get("path")):
            raise ValueError("snapshot inventory path is invalid")
        expected = {"path", "mode", "type"}
        if entry.get("type") == "file":
            expected |= {"size", "sha256"}
        if set(entry) != expected or entry["path"] <= previous:
            raise ValueError("snapshot inventory schema or ordering is invalid")
        if not isinstance(entry["mode"], int) or entry["mode"] < 0 or entry["mode"] > 0o777:
            raise ValueError("snapshot inventory mode is invalid")
        if entry["type"] == "file" and not valid_file_inventory(entry):
            raise ValueError("snapshot file inventory is invalid")
        if entry["type"] not in {"file", "directory"}:
            raise ValueError("snapshot inventory type is invalid")
        previous = entry["path"]
    return entries


def valid_file_inventory(entry: dict[str, Any]) -> bool:
    return (
        isinstance(entry["size"], int)
        and not isinstance(entry["size"], bool)
        and entry["size"] >= 0
        and isinstance(entry["sha256"], str)
        and re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) is not None
    )


def copy_inventory_file(source: Path, target: Path, entry: dict[str, Any]) -> None:
    descriptor, info = open_regular(source)
    metadata = (stat.S_IMODE(info.st_mode), info.st_size)
    if metadata != (entry["mode"], entry["size"]):
        os.close(descriptor)
        raise ValueError(f"source changed during copy: {source}")
    digest = hashlib.sha256()
    with os.fdopen(descriptor, "rb") as reader, target.open("xb") as writer:
        for chunk in iter(lambda: reader.read(1024 * 1024), b""):
            writer.write(chunk)
            digest.update(chunk)
    if not hmac.compare_digest(digest.hexdigest(), entry["sha256"]):
        raise ValueError(f"source changed during copy: {source}")
    os.chmod(target, entry["mode"])


def copy_inventory(source: Path, destination: Path, entries: list[dict[str, Any]]) -> None:
    destination.mkdir(mode=0o700)
    for entry in entries:
        target = destination / entry["path"]
        source_path = source / entry["path"]
        if entry["type"] == "directory":
            info = source_path.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != entry["mode"]:
                raise ValueError(f"source changed during copy: {source_path}")
            target.mkdir(mode=entry["mode"], parents=True, exist_ok=False)
            continue
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        copy_inventory_file(source_path, target, entry)


def fsync_tree(root: Path) -> None:
    files = [path for path in root.rglob("*") if path.is_file()]
    directories = [path for path in root.rglob("*") if path.is_dir()]
    for path in files:
        with path.open("rb") as item:
            os.fsync(item.fileno())
    for path in sorted(directories, key=lambda item: len(item.parts), reverse=True) + [root]:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def private_json(path: Path) -> tuple[dict[str, Any], bytes]:
    contents, info = read_regular(path, 4096)
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError(f"private recovery record has unsafe mode: {path}")
    return strict_json_bytes(contents, path), contents


def valid_hex(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def recovery_tag(key: str, value: dict[str, Any]) -> str:
    return hmac.new(bytes.fromhex(key), canonical_json(value), hashlib.sha256).hexdigest()


def write_private_json(path: Path, value: dict[str, Any], exclusive: bool) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=".pending-recovery-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as destination:
            descriptor = -1
            destination.write(canonical_json(value))
            destination.flush()
            os.fsync(destination.fileno())
        if exclusive:
            os.link(temporary, path)
            temporary.unlink()
        else:
            os.replace(temporary, path)
        fsync_directory(path.parent)
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)
        raise


def cleanup_pending_recovery(*roots: Path) -> None:
    for root in roots:
        changed = False
        for path in root.glob(".pending-recovery-*"):
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise ValueError(f"unsafe interrupted recovery file: {path}")
            path.unlink()
            changed = True
        if changed:
            fsync_directory(root)


def load_recovery_domain(ledger: Path) -> dict[str, Any]:
    path = ledger / RECOVERY_DOMAIN_FILE
    value, _ = private_json(path)
    required = {"version", "domainId", "authenticationKey"}
    if set(value) != required or value["version"] != RECOVERY_VERSION:
        raise ValueError("recovery domain record is invalid")
    if not valid_hex(value["domainId"]) or not valid_hex(value["authenticationKey"]):
        raise ValueError("recovery domain identity or key is invalid")
    return value


def recovery_receipt_paths(ledger: Path) -> list[tuple[int, Path]]:
    paths: list[tuple[int, Path]] = []
    for path in ledger.iterdir():
        match = RECOVERY_RECEIPT_FILE.fullmatch(path.name)
        if match:
            paths.append((int(match.group(1)), path))
        elif path.name.startswith(".recovery-receipt-"):
            raise ValueError(f"invalid recovery receipt filename: {path}")
    return sorted(paths)


def ensure_recovery_domain(ledger: Path) -> dict[str, Any]:
    try:
        return load_recovery_domain(ledger)
    except FileNotFoundError:
        if recovery_receipt_paths(ledger):
            raise ValueError("recovery receipts lack recovery domain")
    value = {
        "version": RECOVERY_VERSION,
        "domainId": os.urandom(32).hex(),
        "authenticationKey": os.urandom(32).hex(),
    }
    write_private_json(ledger / RECOVERY_DOMAIN_FILE, value, exclusive=True)
    return load_recovery_domain(ledger)


def parse_recovery_receipt(
    path: Path, domain: dict[str, Any], sequence: int, previous_digest: str
) -> dict[str, Any]:
    value, contents = private_json(path)
    required = {
        "version", "domainId", "sequence", "previousReceiptSha256", "dataInventorySha256", "authenticationTag"
    }
    if set(value) != required or value["version"] != RECOVERY_VERSION:
        raise ValueError(f"recovery receipt schema mismatch: {path}")
    payload = {key: value[key] for key in required - {"authenticationTag"}}
    valid_link = value["sequence"] == sequence and value["previousReceiptSha256"] == previous_digest
    if not valid_link or value["domainId"] != domain["domainId"] or not valid_hex(value["dataInventorySha256"]):
        raise ValueError(f"recovery receipt lineage mismatch: {path}")
    expected_tag = recovery_tag(domain["authenticationKey"], payload)
    if not valid_hex(value["authenticationTag"]) or not hmac.compare_digest(value["authenticationTag"], expected_tag):
        raise ValueError(f"recovery receipt authentication failed: {path}")
    value["receiptSha256"] = hashlib.sha256(contents).hexdigest()
    return value


def load_recovery_receipts(ledger: Path, domain: dict[str, Any]) -> list[dict[str, Any]]:
    receipts: list[dict[str, Any]] = []
    previous_digest = ZERO_DIGEST
    for expected, (sequence, path) in enumerate(recovery_receipt_paths(ledger), start=1):
        if sequence != expected:
            raise ValueError("recovery receipt sequence is not contiguous")
        receipt = parse_recovery_receipt(path, domain, sequence, previous_digest)
        receipts.append(receipt)
        previous_digest = receipt["receiptSha256"]
    return receipts


def load_recovery_binding(
    data: Path, domain: dict[str, Any], receipts: list[dict[str, Any]], required: bool
) -> dict[str, Any] | None:
    try:
        value, _ = private_json(data / RECOVERY_BINDING_FILE)
    except FileNotFoundError:
        if required:
            raise ValueError("account data lacks authenticated recovery lineage")
        return None
    fields = {"version", "domainId", "sequence", "receiptSha256", "dataInventorySha256", "authenticationTag"}
    if set(value) != fields or value["version"] != RECOVERY_VERSION:
        raise ValueError("recovery data binding schema mismatch")
    sequence = value["sequence"]
    if not valid_generation(sequence) or sequence > len(receipts):
        raise ValueError("recovery data binding sequence is invalid")
    receipt = receipts[sequence - 1]
    linked = value["domainId"] == domain["domainId"] and value["receiptSha256"] == receipt["receiptSha256"]
    linked = linked and value["dataInventorySha256"] == receipt["dataInventorySha256"]
    payload = {key: value[key] for key in fields - {"authenticationTag"}}
    valid_tag = valid_hex(value["authenticationTag"])
    if not linked or not valid_tag or not hmac.compare_digest(
        value["authenticationTag"], recovery_tag(domain["authenticationKey"], payload)
    ):
        raise ValueError("recovery data binding authentication failed")
    return value


def data_state_inventory(data: Path) -> list[dict[str, Any]]:
    return [entry for entry in inventory(data) if entry["path"] != RECOVERY_BINDING_FILE]


def inventory_sha256(entries: list[dict[str, Any]]) -> str:
    return hashlib.sha256(canonical_json(entries)).hexdigest()


def write_recovery_receipt(
    ledger: Path, domain: dict[str, Any], sequence: int, previous: str, data_digest: str
) -> dict[str, Any]:
    payload = {
        "version": RECOVERY_VERSION,
        "domainId": domain["domainId"],
        "sequence": sequence,
        "previousReceiptSha256": previous,
        "dataInventorySha256": data_digest,
    }
    receipt = {**payload, "authenticationTag": recovery_tag(domain["authenticationKey"], payload)}
    path = ledger / f".recovery-receipt-{sequence:016d}.json"
    write_private_json(path, receipt, exclusive=True)
    receipt["receiptSha256"] = hashlib.sha256(canonical_json(receipt)).hexdigest()
    return receipt


def write_recovery_binding(data: Path, domain: dict[str, Any], receipt: dict[str, Any]) -> None:
    payload = {
        "version": RECOVERY_VERSION,
        "domainId": domain["domainId"],
        "sequence": receipt["sequence"],
        "receiptSha256": receipt["receiptSha256"],
        "dataInventorySha256": receipt["dataInventorySha256"],
    }
    binding = {**payload, "authenticationTag": recovery_tag(domain["authenticationKey"], payload)}
    write_private_json(data / RECOVERY_BINDING_FILE, binding, exclusive=False)


def advance_recovery_lineage(data: Path, ledger: Path) -> None:
    domain = ensure_recovery_domain(ledger)
    receipts = load_recovery_receipts(ledger, domain)
    binding = load_recovery_binding(data, domain, receipts, required=False)
    data_digest = inventory_sha256(data_state_inventory(data))
    if binding is None and receipts and receipts[-1]["dataInventorySha256"] != data_digest:
        raise ValueError("unbound account data does not match interrupted recovery receipt")
    sequence = len(receipts) + 1
    if sequence > MAX_SAFE_REVISION:
        raise ValueError("recovery receipt sequence exhausted")
    previous = receipts[-1]["receiptSha256"] if receipts else ZERO_DIGEST
    receipt = write_recovery_receipt(ledger, domain, sequence, previous, data_digest)
    write_recovery_binding(data, domain, receipt)


def validate_recovery_lineage(data: Path, ledger: Path) -> dict[str, Any]:
    domain = load_recovery_domain(ledger)
    receipts = load_recovery_receipts(ledger, domain)
    binding = load_recovery_binding(data, domain, receipts, required=True)
    if binding is None or binding["dataInventorySha256"] != inventory_sha256(data_state_inventory(data)):
        raise ValueError("recovery data binding does not match account data")
    return {
        "recoveryDomainId": domain["domainId"],
        "recoverySequence": binding["sequence"],
        "recoveryReceiptSha256": binding["receiptSha256"],
        "dataInventorySha256": binding["dataInventorySha256"],
    }


def valid_generation(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= MAX_SAFE_REVISION


def valid_positive_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def parse_lifecycle(path: Path) -> dict[str, Any]:
    value = strict_json(path)
    if set(value) != {"version", "generation", "state", "updatedAtMs"}:
        raise ValueError(f"invalid account lifecycle fields: {path}")
    if value["version"] != 1 or not valid_generation(value["generation"]):
        raise ValueError(f"invalid account lifecycle generation: {path}")
    if value["state"] not in {"active", "deleted"} or not valid_generation(value["updatedAtMs"]):
        raise ValueError(f"invalid account lifecycle state: {path}")
    return value


def parse_tombstone(path: Path) -> dict[str, Any]:
    value = strict_json(path)
    if set(value) != {"version", "deletedGeneration", "deletedAtMs"}:
        raise ValueError(f"invalid deletion tombstone fields: {path}")
    if value["version"] != 1 or not valid_generation(value["deletedGeneration"]):
        raise ValueError(f"invalid deletion tombstone generation: {path}")
    if not valid_generation(value["deletedAtMs"]):
        raise ValueError(f"invalid deletion tombstone timestamp: {path}")
    return value


def ledger_high_watermark(ledger: Path) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for path in sorted(ledger.iterdir()):
        lifecycle_match = LIFECYCLE_FILE.fullmatch(path.name)
        tombstone_match = TOMBSTONE_FILE.fullmatch(path.name)
        if lifecycle_match:
            records.setdefault(lifecycle_match.group(1), {})["lifecycle"] = parse_lifecycle(path)
        elif tombstone_match:
            records.setdefault(tombstone_match.group(1), {})["tombstone"] = parse_tombstone(path)
        elif path.name.startswith("account-"):
            raise ValueError(f"invalid account lifecycle filename: {path}")
    return {digest: normalize_high_watermark(digest, value) for digest, value in records.items()}


def normalize_high_watermark(digest: str, value: dict[str, Any]) -> dict[str, Any]:
    lifecycle = value.get("lifecycle")
    tombstone = value.get("tombstone")
    lifecycle_generation = lifecycle["generation"] if lifecycle else 0
    deleted_generation = tombstone["deletedGeneration"] if tombstone else 0
    if lifecycle and lifecycle["state"] == "deleted" and deleted_generation < lifecycle_generation:
        raise ValueError(f"deleted lifecycle lacks tombstone: {digest}")
    state = "deleted" if deleted_generation >= lifecycle_generation and deleted_generation else lifecycle["state"]
    return {
        "generation": max(lifecycle_generation, deleted_generation),
        "state": state,
        "lifecycleGeneration": lifecycle_generation,
        "deletedGeneration": deleted_generation,
    }


def stored_generation(path: Path) -> int:
    database = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        row = database.execute("SELECT generation FROM account_metadata WHERE singleton = 1").fetchone()
    finally:
        database.close()
    if row is None or not valid_generation(row[0]):
        raise ValueError(f"invalid account generation: {path}")
    return row[0]


def account_storage(data: Path) -> dict[str, dict[str, Any]]:
    users = data / "users"
    if not users.exists():
        return {}
    accounts: dict[str, dict[str, Any]] = {}
    for path in users.iterdir():
        match = ACCOUNT_FILE.fullmatch(path.name)
        if not match:
            continue
        account = accounts.setdefault(match.group(1), {"main": None, "sidecars": []})
        if match.group(2):
            account["sidecars"].append(path.name)
        else:
            account["main"] = path
    return accounts


def validate_data_against_ledger(data: Path, ledger: Path) -> dict[str, dict[str, Any]]:
    watermark = ledger_high_watermark(ledger)
    for user_id, storage in account_storage(data).items():
        digest = hashlib.sha256(user_id.encode()).hexdigest()
        record = watermark.get(digest)
        if record is None:
            raise ValueError(f"account storage lacks lifecycle ledger: {user_id}")
        if storage["main"] is None:
            if record["state"] != "deleted" or record["deletedGeneration"] < 1:
                raise ValueError(f"sidecar-only account lacks deletion obligation: {user_id}")
            continue
        generation = stored_generation(storage["main"])
        if generation <= record["deletedGeneration"]:
            continue
        if record["state"] != "active" or record["lifecycleGeneration"] != generation:
            raise ValueError(f"account database exceeds ledger lifecycle: {user_id}")
    return watermark


def write_enrolled_lifecycle(path: Path, generation: int, state: str) -> None:
    record = canonical_json(
        {"version": 1, "generation": generation, "state": state, "updatedAtMs": time.time_ns() // 1_000_000}
    )
    descriptor, temporary_name = tempfile.mkstemp(prefix=".pending-enrollment-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        destination = os.fdopen(descriptor, "wb")
        descriptor = -1
        with destination:
            destination.write(record)
            destination.flush()
            os.fsync(destination.fileno())
        os.link(temporary, path)
        temporary.unlink()
        fsync_directory(path.parent)
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)
        raise


def require_enrollment_delta(
    before: list[dict[str, Any]], after: list[dict[str, Any]], expected: set[str]
) -> None:
    before_by_path = {entry["path"]: entry for entry in before}
    after_by_path = {entry["path"]: entry for entry in after}
    if any(after_by_path.get(path) != entry for path, entry in before_by_path.items()):
        raise RuntimeError("deletion ledger changed during enrollment")
    if set(after_by_path) - set(before_by_path) != expected:
        raise RuntimeError("unexpected deletion ledger inventory change during enrollment")


def planned_lifecycle_records(
    data: Path, ledger: Path, watermark: dict[str, dict[str, Any]]
) -> list[tuple[Path, int, str]]:
    records: list[tuple[Path, int, str]] = []
    for user_id, storage in account_storage(data).items():
        digest = hashlib.sha256(user_id.encode()).hexdigest()
        lifecycle_path = ledger / f"account-{digest}.json"
        if lifecycle_path.exists():
            continue
        deleted_generation = watermark.get(digest, {"deletedGeneration": 0})["deletedGeneration"]
        if storage["main"] is None:
            if deleted_generation < 1:
                raise ValueError(f"sidecar-only account lacks deletion obligation: {user_id}")
            records.append((lifecycle_path, deleted_generation, "deleted"))
            continue
        generation = stored_generation(storage["main"])
        state = "deleted" if generation <= deleted_generation else "active"
        records.append((lifecycle_path, deleted_generation if state == "deleted" else generation, state))
    return records


def enroll_lifecycle(data_arg: Path, ledger_arg: Path) -> None:
    data, ledger = secure_directory(data_arg), secure_directory(ledger_arg)
    require_independent(data, ledger)
    data_before, ledger_before = inventory(data), inventory(ledger)
    plans = planned_lifecycle_records(data, ledger, ledger_high_watermark(ledger))
    additions = {path.name for path, _, _ in plans}
    for lifecycle_path, generation, state in plans:
        write_enrolled_lifecycle(lifecycle_path, generation, state)
    ledger_after = inventory(ledger)
    require_enrollment_delta(ledger_before, ledger_after, additions)
    if inventory(data) != data_before:
        raise RuntimeError("account data changed during enrollment")
    validate_data_against_ledger(data, ledger)
    if inventory(data) != data_before or inventory(ledger) != ledger_after:
        raise RuntimeError("storage changed during enrollment validation")
    print(f"lifecycle enrollment passed: {len(additions)} record(s)")


def manifest_payload(data: Path, ledger: Path) -> dict[str, Any]:
    lineage = validate_recovery_lineage(data, ledger)
    return {
        "version": SNAPSHOT_VERSION,
        "createdAtUnixNs": time.time_ns(),
        "dataInventory": inventory(data),
        "ledgerInventory": inventory(ledger),
        "ledgerHighWatermark": validate_data_against_ledger(data, ledger),
        **lineage,
    }


def write_manifest(root: Path, manifest: dict[str, Any]) -> None:
    contents = canonical_json(manifest)
    (root / "manifest.json").write_bytes(contents)
    (root / "manifest.sha256").write_text(hashlib.sha256(contents).hexdigest() + "  manifest.json\n")


def create_snapshot(data_arg: Path, ledger_arg: Path, output_arg: Path) -> None:
    data, ledger = secure_directory(data_arg), secure_directory(ledger_arg)
    output = output_arg.expanduser().resolve()
    require_independent(data, ledger)
    if output.exists():
        raise ValueError("snapshot output already exists")
    if data in output.parents or ledger in output.parents:
        raise ValueError("snapshot output must be outside live storage")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".snapshot-", dir=output.parent))
    try:
        cleanup_pending_recovery(data, ledger)
        validate_data_against_ledger(data, ledger)
        advance_recovery_lineage(data, ledger)
        data_before, ledger_before = inventory(data), inventory(ledger)
        copy_inventory(ledger, temporary / "ledger", ledger_before)
        copy_inventory(data, temporary / "data", data_before)
        if inventory(data) != data_before or inventory(ledger) != ledger_before:
            raise RuntimeError("source storage changed during snapshot")
        manifest = manifest_payload(temporary / "data", temporary / "ledger")
        if manifest["dataInventory"] != data_before or manifest["ledgerInventory"] != ledger_before:
            raise RuntimeError("snapshot copy does not match source inventory")
        if inventory(temporary / "data") != data_before or inventory(temporary / "ledger") != ledger_before:
            raise RuntimeError("snapshot validation changed copied storage")
        write_manifest(temporary, manifest)
        fsync_tree(temporary)
        temporary.rename(output)
        fsync_directory(output.parent)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    print(f"bound snapshot passed: {output}")


def read_snapshot_manifest(snapshot: Path, expected_digest: str | None) -> tuple[dict[str, Any], str]:
    manifest_path = snapshot / "manifest.json"
    contents, _ = read_regular(manifest_path, 1_048_576)
    manifest_digest = hashlib.sha256(contents).hexdigest()
    if expected_digest is not None:
        if not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
            raise ValueError("trusted manifest SHA-256 is invalid")
        if not hmac.compare_digest(manifest_digest, expected_digest):
            raise ValueError("trusted manifest SHA-256 mismatch")
    checksum_contents, _ = read_regular(snapshot / "manifest.sha256", 256)
    checksum = checksum_contents.decode("ascii").split()
    if checksum != [manifest_digest, "manifest.json"]:
        raise ValueError("snapshot manifest checksum mismatch")
    return strict_json_bytes(contents, manifest_path), manifest_digest


def validate_manifest_schema(manifest: dict[str, Any]) -> None:
    required = {
        "version", "createdAtUnixNs", "dataInventory", "ledgerInventory", "ledgerHighWatermark",
        "recoveryDomainId", "recoverySequence", "recoveryReceiptSha256", "dataInventorySha256",
    }
    if set(manifest) != required or manifest["version"] != SNAPSHOT_VERSION:
        raise ValueError("snapshot manifest schema mismatch")
    if not valid_positive_integer(manifest["createdAtUnixNs"]) or not valid_generation(manifest["recoverySequence"]):
        raise ValueError("snapshot manifest sequence or timestamp is invalid")
    for field in ("recoveryDomainId", "recoveryReceiptSha256", "dataInventorySha256"):
        if not valid_hex(manifest[field]):
            raise ValueError(f"snapshot manifest {field} is invalid")
    validate_inventory(manifest["dataInventory"])
    validate_inventory(manifest["ledgerInventory"])
    if not isinstance(manifest["ledgerHighWatermark"], dict):
        raise ValueError("snapshot ledger high-watermark is invalid")


def expected_lineage(manifest: dict[str, Any]) -> dict[str, Any]:
    fields = ("recoveryDomainId", "recoverySequence", "recoveryReceiptSha256", "dataInventorySha256")
    return {field: manifest[field] for field in fields}


def validate_snapshot_copy(data: Path, ledger: Path, manifest: dict[str, Any]) -> None:
    if validate_data_against_ledger(data, ledger) != manifest["ledgerHighWatermark"]:
        raise ValueError("snapshot ledger high-watermark mismatch")
    if validate_recovery_lineage(data, ledger) != expected_lineage(manifest):
        raise ValueError("snapshot recovery lineage mismatch")
    if inventory(data) != manifest["dataInventory"] or inventory(ledger) != manifest["ledgerInventory"]:
        raise ValueError("snapshot validation changed copied storage")


def verify_snapshot(snapshot_arg: Path, expected_digest: str | None = None) -> tuple[Path, dict[str, Any]]:
    snapshot = secure_directory(snapshot_arg)
    manifest, manifest_digest = read_snapshot_manifest(snapshot, expected_digest)
    validate_manifest_schema(manifest)
    data, ledger = secure_directory(snapshot / "data"), secure_directory(snapshot / "ledger")
    data_inventory, ledger_inventory = inventory(data), inventory(ledger)
    if data_inventory != manifest["dataInventory"] or ledger_inventory != manifest["ledgerInventory"]:
        raise ValueError("snapshot inventory mismatch")
    with tempfile.TemporaryDirectory(prefix="verify-bound-snapshot-") as temporary_name:
        temporary = Path(temporary_name)
        copy_inventory(data, temporary / "data", data_inventory)
        copy_inventory(ledger, temporary / "ledger", ledger_inventory)
        validate_snapshot_copy(temporary / "data", temporary / "ledger", manifest)
    if inventory(data) != data_inventory or inventory(ledger) != ledger_inventory:
        raise ValueError("snapshot inventory changed during verification")
    if not hmac.compare_digest(sha256_file(snapshot / "manifest.json"), manifest_digest):
        raise ValueError("snapshot manifest changed during verification")
    return snapshot, manifest


def mutable_ledger_file(path: str) -> bool:
    name = Path(path).name
    return bool(LIFECYCLE_FILE.fullmatch(name) or TOMBSTONE_FILE.fullmatch(name))


def require_ledger_dominates(trusted: dict[str, Any], baseline: dict[str, Any]) -> None:
    if trusted["recoveryDomainId"] != baseline["recoveryDomainId"]:
        raise ValueError("trusted ledger belongs to a different recovery domain")
    trusted_watermark = trusted["ledgerHighWatermark"]
    for digest, older in baseline["ledgerHighWatermark"].items():
        newer = trusted_watermark.get(digest)
        if newer is None or newer["deletedGeneration"] < older["deletedGeneration"]:
            raise ValueError(f"trusted ledger rolls back deletion watermark: {digest}")
        older_rank = (older["generation"], older["state"] == "deleted")
        newer_rank = (newer["generation"], newer["state"] == "deleted")
        if newer_rank < older_rank:
            raise ValueError(f"trusted ledger is stale: {digest}")
    if trusted["recoverySequence"] < baseline["recoverySequence"]:
        raise ValueError("trusted ledger rolls back recovery sequence")
    trusted_files = {item["path"]: item for item in trusted["ledgerInventory"] if item["type"] == "file"}
    for item in baseline["ledgerInventory"]:
        if item["type"] == "file" and not mutable_ledger_file(item["path"]) and trusted_files.get(item["path"]) != item:
            raise ValueError(f"trusted ledger omits immutable inventory: {item['path']}")


def restore_snapshot(
    snapshot_arg: Path,
    ledger_snapshot_arg: Path,
    data_arg: Path,
    ledger_arg: Path,
    data_digest: str,
    ledger_digest: str,
) -> None:
    snapshot, manifest = verify_snapshot(snapshot_arg, data_digest)
    ledger_snapshot, ledger_manifest = verify_snapshot(ledger_snapshot_arg, ledger_digest)
    require_ledger_dominates(ledger_manifest, manifest)
    data_destination, ledger_destination = data_arg.expanduser().resolve(), ledger_arg.expanduser().resolve()
    require_independent(data_destination, ledger_destination)
    if data_destination.exists() or ledger_destination.exists():
        raise ValueError("restore destinations must not exist")
    data_destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    ledger_destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary_ledger = Path(tempfile.mkdtemp(prefix=".restore-ledger-", dir=ledger_destination.parent))
    temporary_data = Path(tempfile.mkdtemp(prefix=".restore-data-", dir=data_destination.parent))
    try:
        shutil.rmtree(temporary_ledger)
        shutil.rmtree(temporary_data)
        copy_inventory(ledger_snapshot / "ledger", temporary_ledger, ledger_manifest["ledgerInventory"])
        copy_inventory(snapshot / "data", temporary_data, manifest["dataInventory"])
        validate_data_against_ledger(temporary_data, temporary_ledger)
        if validate_recovery_lineage(temporary_data, temporary_ledger) != expected_lineage(manifest):
            raise ValueError("selected data is not linked to trusted ledger recovery sequence")
        if inventory(temporary_data) != manifest["dataInventory"]:
            raise RuntimeError("restored data changed during validation")
        if inventory(temporary_ledger) != ledger_manifest["ledgerInventory"]:
            raise RuntimeError("restored ledger changed during validation")
        verify_snapshot(snapshot, data_digest)
        verify_snapshot(ledger_snapshot, ledger_digest)
        fsync_tree(temporary_ledger)
        fsync_tree(temporary_data)
        temporary_ledger.rename(ledger_destination)
        fsync_directory(ledger_destination.parent)
        temporary_data.rename(data_destination)
        fsync_directory(data_destination.parent)
    except BaseException:
        shutil.rmtree(temporary_ledger, ignore_errors=True)
        shutil.rmtree(temporary_data, ignore_errors=True)
        raise
    print(f"bound restore passed: data={data_destination} ledger={ledger_destination}")


def legacy_database_drill(source_arg: Path, destination_arg: Path) -> None:
    source = source_arg.expanduser().resolve(strict=True)
    destination = destination_arg.expanduser().resolve()
    if source == destination or destination.exists():
        raise ValueError("legacy drill destination must be new and differ from source")
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    restored_db = sqlite3.connect(destination)
    try:
        source_db.backup(restored_db)
        result = restored_db.execute("PRAGMA integrity_check").fetchone()
        if result != ("ok",):
            raise RuntimeError(f"restored integrity check failed: {result!r}")
        table_count = restored_db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
    finally:
        restored_db.close()
        source_db.close()
    print(f"legacy database drill passed: {destination} ({table_count} tables)")


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    subcommands = command.add_subparsers(dest="command")
    snapshot = subcommands.add_parser("snapshot", help="create bound offline snapshot")
    snapshot.add_argument("data", type=Path)
    snapshot.add_argument("ledger", type=Path)
    snapshot.add_argument("output", type=Path)
    restore = subcommands.add_parser("restore", help="restore data with trusted monotonic ledger snapshot")
    restore.add_argument("snapshot", type=Path)
    restore.add_argument("ledger_snapshot", type=Path)
    restore.add_argument("data", type=Path)
    restore.add_argument("ledger", type=Path)
    restore.add_argument("--data-manifest-sha256", required=True)
    restore.add_argument("--ledger-manifest-sha256", required=True)
    verify = subcommands.add_parser("verify", help="verify bound snapshot")
    verify.add_argument("snapshot", type=Path)
    enroll = subcommands.add_parser("enroll", help="enroll authoritative pre-lifecycle account data")
    enroll.add_argument("data", type=Path)
    enroll.add_argument("ledger", type=Path)
    return command


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] not in {"snapshot", "restore", "verify", "enroll"}:
        legacy_database_drill(Path(sys.argv[1]), Path(sys.argv[2]))
        return 0
    args = parser().parse_args()
    if args.command == "snapshot":
        create_snapshot(args.data, args.ledger, args.output)
    elif args.command == "restore":
        restore_snapshot(
            args.snapshot,
            args.ledger_snapshot,
            args.data,
            args.ledger,
            args.data_manifest_sha256,
            args.ledger_manifest_sha256,
        )
    elif args.command == "verify":
        verify_snapshot(args.snapshot)
        print(f"bound snapshot verified: {args.snapshot}")
    elif args.command == "enroll":
        enroll_lifecycle(args.data, args.ledger)
    else:
        parser().error("command required")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
