#!/usr/bin/env python3
"""Validate release source and bind tested native bytes to published assets."""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import re
import subprocess
import tarfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

SEMVER_PATTERN = (
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
TAG_PATTERN = re.compile(rf"^v{SEMVER_PATTERN}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
REPOSITORY_PATTERN = re.compile(r"^[^/\s]+/[^/\s]+$")
VERSION_MARKER_PREFIX = "pomodorough-release-version:"
COMMIT_MARKER_PREFIX = "pomodorough-release-commit:"
NATIVE_SCHEMA = "pomodorough-native-binary-identity/v1"
PACKAGE_SCHEMA = "pomodorough-package-identity/v1"
SBOM_NAME = "pomodorough-server.spdx.json"
CHECKSUM_NAME = "SHA256SUMS"
SUPPORTED_TARGETS = (
    ("linux", "amd64", "pomodorough"),
    ("linux", "arm64", "pomodorough"),
    ("darwin", "amd64", "pomodorough"),
    ("darwin", "arm64", "pomodorough"),
    ("windows", "amd64", "pomodorough.exe"),
)


@dataclasses.dataclass(frozen=True)
class ReleaseContract:
    tag: str
    workflow_sha: str
    event_sha: str
    event_ref: str
    workflow_ref: str
    repository: str


@dataclasses.dataclass(frozen=True)
class ReleaseTarget:
    goos: str
    goarch: str
    binary_name: str

    @property
    def name(self) -> str:
        return f"{self.goos}-{self.goarch}"


def version_from_tag(tag: str) -> str:
    match = TAG_PATTERN.fullmatch(tag)
    if match is None:
        raise ValueError("release tag must be v-prefixed SemVer 2.0.0")
    return tag[1:]


def release_target(goos: str, goarch: str) -> ReleaseTarget:
    for target_os, target_arch, binary_name in SUPPORTED_TARGETS:
        if (target_os, target_arch) == (goos, goarch):
            return ReleaseTarget(target_os, target_arch, binary_name)
    raise ValueError(f"unsupported release target: {goos}/{goarch}")


def validate_source(
    contract: ReleaseContract,
    resolve_commit: Callable[[str], str],
    tracked_source_is_clean: Callable[[], bool] | None = None,
) -> str:
    version = version_from_tag(contract.tag)
    validate_contract_fields(contract)
    if tracked_source_is_clean is None:
        tracked_source_is_clean = git_tracked_source_is_clean
    if not tracked_source_is_clean():
        raise ValueError("tracked worktree or index differs from checked-out commit")
    resolved = {
        "tag": resolve_commit(f"refs/tags/{contract.tag}^{{commit}}"),
        "workflow": resolve_commit(f"{contract.workflow_sha}^{{commit}}"),
        "event": resolve_commit(f"{contract.event_sha}^{{commit}}"),
        "head": resolve_commit("HEAD^{commit}"),
    }
    for name, commit in resolved.items():
        if not COMMIT_PATTERN.fullmatch(commit):
            raise ValueError(f"{name} did not resolve to a lowercase 40-character commit")
    if len(set(resolved.values())) != 1:
        raise ValueError("tag, workflow, event, and checkout do not resolve to one commit")
    return version


def validate_contract_fields(contract: ReleaseContract) -> None:
    if not REPOSITORY_PATTERN.fullmatch(contract.repository):
        raise ValueError("repository must be owner/name")
    if not COMMIT_PATTERN.fullmatch(contract.workflow_sha):
        raise ValueError("workflow SHA must be a lowercase 40-character commit")
    if not COMMIT_PATTERN.fullmatch(contract.event_sha):
        raise ValueError("event SHA must be a lowercase 40-character commit")
    if contract.workflow_sha != contract.event_sha:
        raise ValueError("workflow and event SHA differ")
    expected_ref = f"refs/tags/{contract.tag}"
    if contract.event_ref != expected_ref:
        raise ValueError("event ref does not match release tag")
    expected_workflow = f"{contract.repository}/.github/workflows/release.yml@{expected_ref}"
    if contract.workflow_ref != expected_workflow:
        raise ValueError("workflow ref does not match release tag")


def git_commit(reference: str) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", reference],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def git_tracked_source_is_clean() -> bool:
    result = subprocess.run(
        ["git", "status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=none"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout == ""


def verify_binary_identity_bytes(tag: str, commit: str, binary: bytes) -> str:
    version = version_from_tag(tag)
    if not COMMIT_PATTERN.fullmatch(commit):
        raise ValueError("binary commit must be a lowercase 40-character commit")
    expected_values = {
        "version": f"{VERSION_MARKER_PREFIX}{version}".encode("ascii"),
        "commit": f"{COMMIT_MARKER_PREFIX}{commit}".encode("ascii"),
    }
    for name, value in expected_values.items():
        if binary.count(value) != 1:
            raise ValueError(f"binary must embed exact {name} once")
    return version


def verify_binary_identity(tag: str, commit: str, binary_path: Path) -> str:
    return verify_binary_identity_bytes(tag, commit, binary_path.read_bytes())


def verify_binary_architecture(binary: bytes, target: ReleaseTarget) -> None:
    if target == release_target("linux", "amd64"):
        valid = len(binary) >= 20 and binary[:6] == b"\x7fELF\x02\x01" and int.from_bytes(binary[18:20], "little") == 62
    elif target == release_target("linux", "arm64"):
        valid = len(binary) >= 20 and binary[:6] == b"\x7fELF\x02\x01" and int.from_bytes(binary[18:20], "little") == 183
    elif target == release_target("darwin", "amd64"):
        valid = len(binary) >= 8 and binary[:4] == b"\xcf\xfa\xed\xfe" and int.from_bytes(binary[4:8], "little") == 0x01000007
    elif target == release_target("darwin", "arm64"):
        valid = len(binary) >= 8 and binary[:4] == b"\xcf\xfa\xed\xfe" and int.from_bytes(binary[4:8], "little") == 0x0100000C
    else:
        pe_offset = int.from_bytes(binary[60:64], "little") if len(binary) >= 64 else 0
        valid = (
            binary[:2] == b"MZ"
            and pe_offset + 6 <= len(binary)
            and binary[pe_offset : pe_offset + 4] == b"PE\0\0"
            and int.from_bytes(binary[pe_offset + 4 : pe_offset + 6], "little") == 0x8664
        )
    if not valid:
        raise ValueError(f"binary architecture does not match {target.goos}/{target.goarch}")


def sha256_bytes(contents: bytes) -> str:
    return hashlib.sha256(contents).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exact_version_output(version: str, commit: str) -> bytes:
    return f"pomodorough version={version} commit={commit}\n".encode("utf-8")


def execute_exact_version(binary_path: Path, version: str, commit: str) -> None:
    result = subprocess.run([str(binary_path), "--version"], check=False, capture_output=True)
    if result.returncode != 0:
        raise ValueError(f"native --version exited {result.returncode}")
    if result.stdout != exact_version_output(version, commit):
        raise ValueError("native --version stdout differs from exact identity plus one newline")
    if result.stderr != b"":
        raise ValueError("native --version wrote stderr")


def write_json(path: Path, record: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_record(path: Path, expected_keys: set[str]) -> dict[str, str]:
    record: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or set(record) != expected_keys:
        raise ValueError(f"{path.name} has unexpected identity fields")
    if not all(isinstance(value, str) for value in record.values()):
        raise ValueError(f"{path.name} identity fields must be strings")
    return record


def native_record_keys() -> set[str]:
    return {"schema", "target", "tag", "version", "commit", "binary", "binary_sha256"}


def package_record_keys() -> set[str]:
    return {
        "schema", "target", "tag", "version", "commit", "archive", "archive_sha256",
        "archive_member", "archive_member_sha256", "tested_binary_sha256", "native_record_sha256",
    }


def release_package(tag: str, target: ReleaseTarget) -> str:
    return f"pomodorough-{version_from_tag(tag)}-{target.name}"


def native_record_asset_name(tag: str, target: ReleaseTarget) -> str:
    return f"{release_package(tag, target)}.native.json"


def native_record_asset_names(tag: str) -> list[str]:
    return sorted(
        native_record_asset_name(tag, release_target(goos, goarch))
        for goos, goarch, _ in SUPPORTED_TARGETS
    )


def create_native_record(
    tag: str,
    commit: str,
    target: ReleaseTarget,
    binary_path: Path,
) -> dict[str, str]:
    binary = binary_path.read_bytes()
    version = verify_binary_identity_bytes(tag, commit, binary)
    verify_binary_architecture(binary, target)
    execute_exact_version(binary_path, version, commit)
    return {
        "schema": NATIVE_SCHEMA,
        "target": target.name,
        "tag": tag,
        "version": version,
        "commit": commit,
        "binary": target.binary_name,
        "binary_sha256": sha256_bytes(binary),
    }


def validate_native_record(
    record: dict[str, str],
    tag: str,
    commit: str,
    target: ReleaseTarget,
) -> None:
    expected = {
        "schema": NATIVE_SCHEMA,
        "target": target.name,
        "tag": tag,
        "version": version_from_tag(tag),
        "commit": commit,
        "binary": target.binary_name,
    }
    for name, value in expected.items():
        if record[name] != value:
            raise ValueError(f"native identity {name} mismatch")
    if not SHA256_PATTERN.fullmatch(record["binary_sha256"]):
        raise ValueError("native binary SHA-256 is malformed")


def archive_member_bytes(archive_path: Path, member_name: str) -> bytes:
    with tarfile.open(archive_path, "r:gz") as archive:
        matches = [member for member in archive.getmembers() if member.name == member_name]
        if len(matches) != 1 or not matches[0].isfile():
            raise ValueError("archive must contain exactly one regular native binary member")
        stream = archive.extractfile(matches[0])
        if stream is None:
            raise ValueError("archive native binary member cannot be read")
        return stream.read()


def validate_archive_layout(archive_path: Path, package: str, binary_name: str) -> None:
    required = {
        f"{package}/{binary_name}",
        f"{package}/web/index.html",
        f"{package}/web/privacy.html",
        f"{package}/deploy/pomodorough.service",
        f"{package}/deploy/pomodorough.env.example",
        f"{package}/scripts/restore_drill.py",
    }
    with tarfile.open(archive_path, "r:gz") as archive:
        names = {member.name for member in archive.getmembers()}
    missing = sorted(required - names)
    if missing:
        raise ValueError(f"archive layout missing: {', '.join(missing)}")


def create_package_record(
    tag: str,
    commit: str,
    target: ReleaseTarget,
    native_record_path: Path,
    binary_path: Path,
    archive_path: Path,
) -> dict[str, str]:
    package = release_package(tag, target)
    member_name = f"{package}/{target.binary_name}"
    native_record = read_record(native_record_path, native_record_keys())
    validate_native_record(native_record, tag, commit, target)
    tested_binary = binary_path.read_bytes()
    verify_binary_identity_bytes(tag, commit, tested_binary)
    verify_binary_architecture(tested_binary, target)
    if sha256_bytes(tested_binary) != native_record["binary_sha256"]:
        raise ValueError("packaging binary differs from native-tested binary")
    archive_binary = archive_member_bytes(archive_path, member_name)
    if archive_binary != tested_binary:
        raise ValueError("archive member differs from native-tested binary")
    verify_binary_identity_bytes(tag, commit, archive_binary)
    verify_binary_architecture(archive_binary, target)
    validate_archive_layout(archive_path, package, target.binary_name)
    return package_record(tag, commit, target, native_record_path, archive_path, member_name, archive_binary)


def package_record(
    tag: str,
    commit: str,
    target: ReleaseTarget,
    native_record_path: Path,
    archive_path: Path,
    member_name: str,
    archive_binary: bytes,
) -> dict[str, str]:
    version = version_from_tag(tag)
    binary_hash = sha256_bytes(archive_binary)
    return {
        "schema": PACKAGE_SCHEMA,
        "target": target.name,
        "tag": tag,
        "version": version,
        "commit": commit,
        "archive": archive_path.name,
        "archive_sha256": sha256_path(archive_path),
        "archive_member": member_name,
        "archive_member_sha256": binary_hash,
        "tested_binary_sha256": binary_hash,
        "native_record_sha256": sha256_path(native_record_path),
    }


def validate_package_record(
    record_path: Path,
    archive_path: Path,
    native_record_path: Path,
    tag: str,
    commit: str,
    target: ReleaseTarget,
) -> None:
    record = read_record(record_path, package_record_keys())
    native_record = read_record(native_record_path, native_record_keys())
    validate_native_record(native_record, tag, commit, target)
    version = version_from_tag(tag)
    package = release_package(tag, target)
    expected = {
        "schema": PACKAGE_SCHEMA,
        "target": target.name,
        "tag": tag,
        "version": version,
        "commit": commit,
        "archive": archive_path.name,
        "archive_member": f"{package}/{target.binary_name}",
    }
    for name, value in expected.items():
        if record[name] != value:
            raise ValueError(f"package identity {name} mismatch")
    validate_package_hashes(record, native_record, native_record_path, archive_path, tag, commit, target)
    validate_archive_layout(archive_path, package, target.binary_name)


def validate_package_hashes(
    record: dict[str, str],
    native_record: dict[str, str],
    native_record_path: Path,
    archive_path: Path,
    tag: str,
    commit: str,
    target: ReleaseTarget,
) -> None:
    hash_fields = ("archive_sha256", "archive_member_sha256", "tested_binary_sha256", "native_record_sha256")
    if any(not SHA256_PATTERN.fullmatch(record[name]) for name in hash_fields):
        raise ValueError("package identity contains malformed SHA-256")
    if sha256_path(native_record_path) != record["native_record_sha256"]:
        raise ValueError("package identity differs from trusted native record")
    if native_record["binary_sha256"] != record["tested_binary_sha256"]:
        raise ValueError("package identity differs from native-tested binary")
    if sha256_path(archive_path) != record["archive_sha256"]:
        raise ValueError("final archive differs from package identity")
    archive_binary = archive_member_bytes(archive_path, record["archive_member"])
    member_hash = sha256_bytes(archive_binary)
    if member_hash != record["archive_member_sha256"]:
        raise ValueError("final archive member differs from package identity")
    if member_hash != record["tested_binary_sha256"]:
        raise ValueError("final archive member differs from native-tested binary")
    if member_hash != native_record["binary_sha256"]:
        raise ValueError("final archive member differs from trusted native record")
    verify_binary_identity_bytes(tag, commit, archive_binary)
    verify_binary_architecture(archive_binary, target)


def release_asset_names(tag: str, include_checksums: bool) -> list[str]:
    names = [SBOM_NAME]
    for goos, goarch, _ in SUPPORTED_TARGETS:
        target = release_target(goos, goarch)
        package = release_package(tag, target)
        names.extend((f"{package}.tar.gz", f"{package}.identity.json", native_record_asset_name(tag, target)))
    if include_checksums:
        names.append(CHECKSUM_NAME)
    return sorted(names)


def validate_release_assets(
    directory: Path,
    tag: str,
    commit: str,
    include_checksums: bool,
    native_record_directory: Path | None = None,
) -> list[str]:
    trusted_directory = native_record_directory or directory
    validate_native_record_assets(trusted_directory, tag)
    expected = release_asset_names(tag, include_checksums)
    actual = sorted(path.name for path in directory.iterdir() if path.is_file())
    if actual != expected:
        raise ValueError(f"release asset set mismatch: expected {expected}, got {actual}")
    for goos, goarch, _ in SUPPORTED_TARGETS:
        target = release_target(goos, goarch)
        package = release_package(tag, target)
        native_name = native_record_asset_name(tag, target)
        trusted_record = trusted_directory / native_name
        if sha256_path(directory / native_name) != sha256_path(trusted_record):
            raise ValueError("published native record differs from trusted native record")
        validate_package_record(
            directory / f"{package}.identity.json",
            directory / f"{package}.tar.gz",
            trusted_record,
            tag,
            commit,
            target,
        )
    return [name for name in expected if name != CHECKSUM_NAME]


def validate_native_record_assets(directory: Path, tag: str) -> None:
    expected = native_record_asset_names(tag)
    actual = sorted(path.name for path in directory.glob("*.native.json") if path.is_file())
    if actual != expected:
        raise ValueError(f"trusted native record set mismatch: expected {expected}, got {actual}")


def checksum_contents(directory: Path, names: list[str]) -> bytes:
    lines = [f"{sha256_path(directory / name)}  {name}\n" for name in sorted(names)]
    return "".join(lines).encode("ascii")


def finalize_release(
    directory: Path,
    tag: str,
    commit: str,
    output_path: Path,
    native_record_directory: Path | None = None,
) -> None:
    if output_path.parent.resolve() != directory.resolve() or output_path.name != CHECKSUM_NAME:
        raise ValueError("checksum output must be release directory/SHA256SUMS")
    names = validate_release_assets(directory, tag, commit, include_checksums=False, native_record_directory=native_record_directory)
    output_path.write_bytes(checksum_contents(directory, names))


def verify_release(
    directory: Path,
    tag: str,
    commit: str,
    checksum_path: Path,
    native_record_directory: Path | None = None,
) -> None:
    if checksum_path.parent.resolve() != directory.resolve() or checksum_path.name != CHECKSUM_NAME:
        raise ValueError("checksum manifest must be release directory/SHA256SUMS")
    names = validate_release_assets(directory, tag, commit, include_checksums=True, native_record_directory=native_record_directory)
    expected = checksum_contents(directory, names)
    if checksum_path.read_bytes() != expected:
        raise ValueError("checksum manifest does not exactly match final release assets")


def add_target_arguments(command: argparse.ArgumentParser) -> None:
    command.add_argument("--tag", required=True)
    command.add_argument("--commit", required=True)
    command.add_argument("--goos", required=True)
    command.add_argument("--goarch", required=True)


def record_binary_command(arguments: argparse.Namespace) -> None:
    target = release_target(arguments.goos, arguments.goarch)
    record = create_native_record(arguments.tag, arguments.commit, target, arguments.binary)
    write_json(arguments.output, record)


def bind_archive_command(arguments: argparse.Namespace) -> None:
    target = release_target(arguments.goos, arguments.goarch)
    record = create_package_record(
        arguments.tag,
        arguments.commit,
        target,
        arguments.native_record,
        arguments.binary,
        arguments.archive,
    )
    write_json(arguments.output, record)


def validate_source_command(arguments: argparse.Namespace) -> None:
    contract = ReleaseContract(
        tag=arguments.tag,
        workflow_sha=arguments.workflow_sha,
        event_sha=arguments.event_sha,
        event_ref=arguments.event_ref,
        workflow_ref=arguments.workflow_ref,
        repository=arguments.github_repository,
    )
    print(validate_source(contract, git_commit, git_tracked_source_is_clean))


def parser() -> argparse.ArgumentParser:
    command_parser = argparse.ArgumentParser(description=__doc__)
    subparsers = command_parser.add_subparsers(dest="command", required=True)
    version_parser = subparsers.add_parser("version")
    version_parser.add_argument("tag")
    version_parser.set_defaults(action=lambda arguments: print(version_from_tag(arguments.tag)))
    source_parser = subparsers.add_parser("validate-source")
    for name in ("tag", "workflow-sha", "event-sha", "event-ref", "workflow-ref", "github-repository"):
        source_parser.add_argument(f"--{name}", required=True)
    source_parser.set_defaults(action=validate_source_command)
    add_binary_parsers(subparsers)
    add_release_parsers(subparsers)
    return command_parser


def add_binary_parsers(subparsers: argparse._SubParsersAction) -> None:
    verify_parser = subparsers.add_parser("verify-binary")
    verify_parser.add_argument("--tag", required=True)
    verify_parser.add_argument("--commit", required=True)
    verify_parser.add_argument("binary", type=Path)
    verify_parser.set_defaults(action=lambda arguments: print(verify_binary_identity(arguments.tag, arguments.commit, arguments.binary)))
    record_parser = subparsers.add_parser("record-binary")
    add_target_arguments(record_parser)
    record_parser.add_argument("--binary", required=True, type=Path)
    record_parser.add_argument("--output", required=True, type=Path)
    record_parser.set_defaults(action=record_binary_command)
    bind_parser = subparsers.add_parser("bind-archive")
    add_target_arguments(bind_parser)
    bind_parser.add_argument("--native-record", required=True, type=Path)
    bind_parser.add_argument("--binary", required=True, type=Path)
    bind_parser.add_argument("--archive", required=True, type=Path)
    bind_parser.add_argument("--output", required=True, type=Path)
    bind_parser.set_defaults(action=bind_archive_command)


def add_release_parsers(subparsers: argparse._SubParsersAction) -> None:
    finalize_parser = subparsers.add_parser("finalize-release")
    finalize_parser.add_argument("--tag", required=True)
    finalize_parser.add_argument("--commit", required=True)
    finalize_parser.add_argument("--directory", required=True, type=Path)
    finalize_parser.add_argument("--output", required=True, type=Path)
    finalize_parser.add_argument("--native-record-directory", type=Path)
    finalize_parser.set_defaults(
        action=lambda arguments: finalize_release(
            arguments.directory, arguments.tag, arguments.commit, arguments.output, arguments.native_record_directory
        )
    )
    verify_parser = subparsers.add_parser("verify-release")
    verify_parser.add_argument("--tag", required=True)
    verify_parser.add_argument("--commit", required=True)
    verify_parser.add_argument("--directory", required=True, type=Path)
    verify_parser.add_argument("--checksums", required=True, type=Path)
    verify_parser.add_argument("--native-record-directory", type=Path)
    verify_parser.set_defaults(
        action=lambda arguments: verify_release(
            arguments.directory, arguments.tag, arguments.commit, arguments.checksums, arguments.native_record_directory
        )
    )


def main() -> None:
    arguments = parser().parse_args()
    try:
        arguments.action(arguments)
    except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError, tarfile.TarError) as error:
        raise SystemExit(f"release identity validation failed: {error}") from error


if __name__ == "__main__":
    main()
