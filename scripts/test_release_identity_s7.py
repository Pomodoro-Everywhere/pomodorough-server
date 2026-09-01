#!/usr/bin/env python3
"""Independent adversarial tests for S7 release identity."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import re
import subprocess
import sys
import tempfile
import tarfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
IDENTITY_PATH = ROOT / "scripts" / "release_identity.py"
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "release.yml"
GO_TEST_PATH = ROOT / "cmd" / "pomodorough" / "version_s7_test.go"
DOC_PATH = ROOT / "docs" / "release-identity-s7.md"
TAG = "v1.2.3-rc.1+build.7"
VERSION = TAG[1:]
COMMIT = "0123456789abcdef0123456789abcdef01234567"

EXPECTED_TARGETS = (
    ("linux", "amd64", "pomodorough"),
    ("linux", "arm64", "pomodorough"),
    ("darwin", "amd64", "pomodorough"),
    ("darwin", "arm64", "pomodorough"),
    ("windows", "amd64", "pomodorough.exe"),
)
EXPECTED_BUILD_MATRIX = (
    ("linux", "amd64", "ubuntu-24.04", "pomodorough"),
    ("linux", "arm64", "ubuntu-24.04-arm", "pomodorough"),
    ("darwin", "amd64", "macos-15-intel", "pomodorough"),
    ("darwin", "arm64", "macos-14", "pomodorough"),
    ("windows", "amd64", "windows-2022", "pomodorough.exe"),
)
EXPECTED_PACKAGE_MATRIX = tuple(
    (goos, goarch, binary) for goos, goarch, binary in EXPECTED_TARGETS
)
EXPECTED_PUBLIC_ASSET_MATRIX = (
    "pomodorough-${version}-darwin-amd64.tar.gz",
    "pomodorough-${version}-darwin-amd64.identity.json",
    "pomodorough-${version}-darwin-amd64.native.json",
    "pomodorough-${version}-darwin-arm64.tar.gz",
    "pomodorough-${version}-darwin-arm64.identity.json",
    "pomodorough-${version}-darwin-arm64.native.json",
    "pomodorough-${version}-linux-amd64.tar.gz",
    "pomodorough-${version}-linux-amd64.identity.json",
    "pomodorough-${version}-linux-amd64.native.json",
    "pomodorough-${version}-linux-arm64.tar.gz",
    "pomodorough-${version}-linux-arm64.identity.json",
    "pomodorough-${version}-linux-arm64.native.json",
    "pomodorough-${version}-windows-amd64.tar.gz",
    "pomodorough-${version}-windows-amd64.identity.json",
    "pomodorough-${version}-windows-amd64.native.json",
    "pomodorough-server.spdx.json",
    "SHA256SUMS",
)


def load_identity_module():
    specification = importlib.util.spec_from_file_location("release_identity_s7", IDENTITY_PATH)
    if specification is None or specification.loader is None:
        raise RuntimeError("cannot load release_identity.py")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def package_name(goos: str, goarch: str) -> str:
    return f"pomodorough-{VERSION}-{goos}-{goarch}"


def fixed_asset_names(include_checksums: bool) -> list[str]:
    names = ["pomodorough-server.spdx.json"]
    for goos, goarch, _ in EXPECTED_TARGETS:
        package = package_name(goos, goarch)
        names.extend((f"{package}.tar.gz", f"{package}.identity.json", f"{package}.native.json"))
    if include_checksums:
        names.append("SHA256SUMS")
    return sorted(names)


def sha256_bytes(contents: bytes) -> str:
    return hashlib.sha256(contents).hexdigest()


def sha256_path(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def write_json(path: Path, record: dict[str, str]) -> None:
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_json(path: Path) -> dict[str, str]:
    return json.loads(path.read_text(encoding="utf-8"))


def fake_binary(goos: str, goarch: str, nonce: bytes = b"") -> bytes:
    if goos == "linux":
        binary = bytearray(64)
        binary[:6] = b"\x7fELF\x02\x01"
        binary[18:20] = (62 if goarch == "amd64" else 183).to_bytes(2, "little")
    elif goos == "darwin":
        binary = bytearray(32)
        binary[:4] = b"\xcf\xfa\xed\xfe"
        cpu = 0x01000007 if goarch == "amd64" else 0x0100000C
        binary[4:8] = cpu.to_bytes(4, "little")
    else:
        binary = bytearray(160)
        binary[:2] = b"MZ"
        binary[60:64] = (128).to_bytes(4, "little")
        binary[128:132] = b"PE\0\0"
        binary[132:134] = (0x8664).to_bytes(2, "little")
    markers = (
        f"pomodorough-release-version:{VERSION}\0"
        f"pomodorough-release-commit:{COMMIT}\0"
    ).encode("ascii")
    return bytes(binary) + markers + nonce


def add_tar_file(archive: tarfile.TarFile, name: str, contents: bytes) -> None:
    member = tarfile.TarInfo(name)
    member.size = len(contents)
    member.mode = 0o755 if name.endswith(("pomodorough", "pomodorough.exe")) else 0o644
    archive.addfile(member, io.BytesIO(contents))


def write_archive(path: Path, package: str, binary_name: str, binary: bytes, duplicate: bool = False) -> None:
    members = (
        (f"{package}/{binary_name}", binary),
        (f"{package}/web/index.html", b"index"),
        (f"{package}/web/privacy.html", b"privacy"),
        (f"{package}/deploy/pomodorough.service", b"service"),
        (f"{package}/deploy/pomodorough.env.example", b"environment"),
        (f"{package}/scripts/restore_drill.py", b"restore"),
    )
    with tarfile.open(path, "w:gz") as archive:
        for name, contents in members:
            add_tar_file(archive, name, contents)
        if duplicate:
            add_tar_file(archive, f"{package}/{binary_name}", binary)


def expected_checksums(directory: Path) -> bytes:
    lines = []
    for name in fixed_asset_names(include_checksums=False):
        lines.append(f"{sha256_path(directory / name)}  {name}\n")
    return "".join(lines).encode("ascii")


def rewrite_checksums(directory: Path) -> None:
    (directory / "SHA256SUMS").write_bytes(expected_checksums(directory))


def job_text(workflow: str, job: str) -> str:
    match = re.search(rf"^  {re.escape(job)}:\n(.*?)(?=^  [a-z][a-z0-9_-]*:\n|\Z)", workflow, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else ""


def step_names(workflow: str, job: str) -> list[str]:
    return re.findall(r"^      - name: (.+)$", job_text(workflow, job), re.MULTILINE)


def build_matrix(workflow: str) -> tuple[tuple[str, str, str, str], ...]:
    pattern = re.compile(
        r"^          - goos: (\S+)\n"
        r"            goarch: (\S+)\n"
        r"            runner: (\S+)\n"
        r"            binary: (\S+)$",
        re.MULTILINE,
    )
    return tuple(pattern.findall(job_text(workflow, "build")))


def package_matrix(workflow: str) -> tuple[tuple[str, str, str], ...]:
    pattern = re.compile(
        r"^          - goos: (\S+)\n"
        r"            goarch: (\S+)\n"
        r"            binary: (\S+)$",
        re.MULTILINE,
    )
    return tuple(pattern.findall(job_text(workflow, "package")))


def public_asset_matrix(workflow: str) -> tuple[str, ...]:
    release = job_text(workflow, "release")
    match = re.search(r"^          expected_assets=\(\n(.*?)^          \)$", release, re.MULTILINE | re.DOTALL)
    if match is None:
        return ()
    return tuple(re.findall(r'^            "([^"]+)"$', match.group(1), re.MULTILINE))


def workflow_contract_errors(workflow: str) -> list[str]:
    errors = []
    if build_matrix(workflow) != EXPECTED_BUILD_MATRIX:
        errors.append("build matrix")
    if package_matrix(workflow) != EXPECTED_PACKAGE_MATRIX:
        errors.append("package matrix")
    if public_asset_matrix(workflow) != EXPECTED_PUBLIC_ASSET_MATRIX:
        errors.append("public asset matrix")
    errors.extend(required_workflow_errors(workflow))
    errors.extend(step_order_errors(workflow))
    return errors


def required_workflow_errors(workflow: str) -> list[str]:
    required = {
        "tag source binding": "validate-source",
        "tracked source validation": "--workflow-ref \"$GITHUB_WORKFLOW_REF\"",
        "native record asset": "dist/native/${package}.native.json",
        "native attestation": "Attest immutable native test record",
        "separate native artifact": "name: native-record-${{ matrix.goos }}-${{ matrix.goarch }}",
        "package native binding": "--native-record \"binary/${package}.native.json\"",
        "native attestation verification": "gh attestation verify \"$record\" --repo \"$GH_REPO\"",
        "independent native download": "pattern: native-record-*",
        "trusted native path": "path: trusted-native-records",
        "trusted finalizer input": "--native-record-directory trusted-native-records",
        "native publication": "dist/*.native.json",
        "darwin amd64 archive": "pomodorough-${version}-darwin-amd64.tar.gz",
        "darwin amd64 identity": "pomodorough-${version}-darwin-amd64.identity.json",
        "darwin amd64 native record": "pomodorough-${version}-darwin-amd64.native.json",
        "SBOM": "dist/pomodorough-server.spdx.json",
        "checksums": "dist/SHA256SUMS",
        "draft gate": "Download and verify draft release assets",
    }
    return [name for name, token in required.items() if token not in workflow]


def step_order_errors(workflow: str) -> list[str]:
    expected = {
        "build": [
            "Build reproducible native binary",
            "Build reproducible native Windows binary",
            "Smoke-test and bind native binary identity",
            "Smoke-test and bind native Windows binary identity",
            "Attest immutable native test record",
            "Upload native binary",
            "Upload immutable native test record",
        ],
        "package": [
            "Download native binary",
            "Verify native binary and test-record attestations",
            "Build reproducible archive",
            "Bind final archive to native-tested binary",
            "Attest archive and identity binding",
            "Upload archive and identity binding",
        ],
        "release": [
            "Download archives and identity bindings",
            "Download immutable native test records",
            "Verify package attestations",
            "Export SPDX SBOM",
            "Verify and import immutable native test records",
            "Finalize release identity and checksums",
            "Attest SBOM and checksum manifest",
            "Create draft GitHub release",
            "Download and verify draft release assets",
            "Publish verified release",
        ],
    }
    errors = []
    for job, suffix in expected.items():
        if step_names(workflow, job)[-len(suffix):] != suffix:
            errors.append(f"{job} terminal step order")
    return errors


class ReleaseFixture:
    def __init__(self, identity, directory: Path):
        self.identity = identity
        self.directory = directory

    def paths(self, goos: str, goarch: str) -> tuple[Path, Path, Path, Path]:
        package = package_name(goos, goarch)
        return (
            self.directory / f"{package}.binary",
            self.directory / f"{package}.tar.gz",
            self.directory / f"{package}.identity.json",
            self.directory / f"{package}.native.json",
        )

    def add_target(self, goos: str, goarch: str, nonce: bytes = b"") -> tuple[Path, Path, Path, Path]:
        target = self.identity.release_target(goos, goarch)
        binary_path, archive_path, identity_path, native_path = self.paths(goos, goarch)
        binary = fake_binary(goos, goarch, nonce)
        binary_path.write_bytes(binary)
        native = self.native_record(target, binary)
        write_json(native_path, native)
        write_archive(archive_path, package_name(goos, goarch), target.binary_name, binary)
        package = self.identity.create_package_record(TAG, COMMIT, target, native_path, binary_path, archive_path)
        write_json(identity_path, package)
        binary_path.unlink()
        return binary_path, archive_path, identity_path, native_path

    def native_record(self, target, binary: bytes) -> dict[str, str]:
        return {
            "schema": "pomodorough-native-binary-identity/v1",
            "target": target.name,
            "tag": TAG,
            "version": VERSION,
            "commit": COMMIT,
            "binary": target.binary_name,
            "binary_sha256": sha256_bytes(binary),
        }

    def complete_release(self) -> None:
        for goos, goarch, _ in EXPECTED_TARGETS:
            self.add_target(goos, goarch)
        (self.directory / "pomodorough-server.spdx.json").write_text("{}\n", encoding="utf-8")
        self.identity.finalize_release(self.directory, TAG, COMMIT, self.directory / "SHA256SUMS")


class ReleaseIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.identity = load_identity_module()
        cls.workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

    def contract(self):
        return self.identity.ReleaseContract(
            tag=TAG,
            workflow_sha=COMMIT,
            event_sha=COMMIT,
            event_ref=f"refs/tags/{TAG}",
            workflow_ref=f"owner/repo/.github/workflows/release.yml@refs/tags/{TAG}",
            repository="owner/repo",
        )

    def test_full_semver_tag_contract(self) -> None:
        valid = ("v0.0.0", "v1.2.3-rc.1", "v1.2.3+build.7", "v1.2.3-01A+001")
        invalid = ("1.2.3", "v01.2.3", "v1.02.3", "v1.2", "v1.2.3-01", "v1.2.3+")
        for tag in valid:
            self.assertEqual(self.identity.version_from_tag(tag), tag[1:])
        for tag in invalid:
            with self.assertRaises(ValueError, msg=tag):
                self.identity.version_from_tag(tag)

    def test_fixed_target_and_public_asset_contract(self) -> None:
        self.assertEqual(self.identity.SUPPORTED_TARGETS, EXPECTED_TARGETS)
        self.assertEqual(self.identity.release_asset_names(TAG, True), fixed_asset_names(True))
        self.assertIn(("darwin", "amd64", "pomodorough"), EXPECTED_TARGETS)

    def test_source_contract_rejects_tracked_and_index_drift(self) -> None:
        resolver = lambda _reference: COMMIT
        self.assertEqual(self.identity.validate_source(self.contract(), resolver, lambda: True), VERSION)
        with self.assertRaisesRegex(ValueError, "worktree or index"):
            self.identity.validate_source(self.contract(), resolver, lambda: False)

    def test_git_clean_check_explicitly_ignores_untracked_only(self) -> None:
        for output, expected in (("", True), (" M tracked.go\n", False), ("M  indexed.go\n", False)):
            result = subprocess.CompletedProcess([], 0, stdout=output, stderr="")
            with mock.patch.object(self.identity.subprocess, "run", return_value=result) as run:
                self.assertEqual(self.identity.git_tracked_source_is_clean(), expected)
            command = run.call_args.args[0]
            self.assertIn("--untracked-files=no", command)
            self.assertIn("--ignore-submodules=none", command)

    def test_exact_version_bytes_include_one_newline(self) -> None:
        expected = f"pomodorough version={VERSION} commit={COMMIT}\n".encode("utf-8")
        self.assertEqual(self.identity.exact_version_output(VERSION, COMMIT), expected)
        self.assertFalse(expected.endswith(b"\n\n"))

    def test_native_smoke_rejects_whitespace_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "version"
            output = f"pomodorough version={VERSION} commit={COMMIT}  \n"
            executable.write_text(f"#!/bin/sh\nprintf '%s' '{output}'\n", encoding="utf-8")
            executable.chmod(0o755)
            with self.assertRaisesRegex(ValueError, "stdout differs"):
                self.identity.execute_exact_version(executable, VERSION, COMMIT)

    def test_package_rejects_post_smoke_binary_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = ReleaseFixture(self.identity, Path(temporary))
            binary_path, archive_path, _, native_path = fixture.add_target("linux", "amd64")
            replacement = fake_binary("linux", "amd64", b"replacement")
            binary_path.write_bytes(replacement)
            write_archive(archive_path, package_name("linux", "amd64"), "pomodorough", replacement)
            with self.assertRaisesRegex(ValueError, "native-tested binary"):
                self.identity.create_package_record(
                    TAG, COMMIT, self.identity.release_target("linux", "amd64"),
                    native_path, binary_path, archive_path,
                )

    def test_native_record_validates_every_identity_field(self) -> None:
        target = self.identity.release_target("linux", "amd64")
        fixture = ReleaseFixture(self.identity, Path("."))
        record = fixture.native_record(target, fake_binary("linux", "amd64"))
        self.identity.validate_native_record(record, TAG, COMMIT, target)
        mutations = {
            "schema": "forged-schema",
            "target": "darwin-amd64",
            "tag": "v9.9.9",
            "version": "9.9.9",
            "commit": "f" * 40,
            "binary": "forged",
            "binary_sha256": "malformed",
        }
        for field, value in mutations.items():
            forged = dict(record)
            forged[field] = value
            with self.assertRaises(ValueError, msg=field):
                self.identity.validate_native_record(forged, TAG, COMMIT, target)

    def test_package_rejects_same_arch_archive_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = ReleaseFixture(self.identity, Path(temporary))
            binary_path, archive_path, _, native_path = fixture.add_target("darwin", "amd64")
            binary_path.write_bytes(fake_binary("darwin", "amd64"))
            replacement = fake_binary("darwin", "amd64", b"same-arch-forgery")
            write_archive(archive_path, package_name("darwin", "amd64"), "pomodorough", replacement)
            with self.assertRaisesRegex(ValueError, "archive member differs"):
                self.identity.create_package_record(
                    TAG, COMMIT, self.identity.release_target("darwin", "amd64"),
                    native_path, binary_path, archive_path,
                )

    def test_complete_five_target_release_verifies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            fixture = ReleaseFixture(self.identity, directory)
            fixture.complete_release()
            self.identity.verify_release(directory, TAG, COMMIT, directory / "SHA256SUMS")
            self.assertEqual(sorted(path.name for path in directory.iterdir()), fixed_asset_names(True))

    def test_finalizer_rejects_post_bind_archive_mutation(self) -> None:
        directory, context = self.complete_temporary_release()
        with context:
            archive = directory / f"{package_name('linux', 'amd64')}.tar.gz"
            archive.write_bytes(archive.read_bytes() + b"post-bind")
            rewrite_checksums(directory)
            with self.assertRaisesRegex(ValueError, "final archive differs"):
                self.identity.verify_release(directory, TAG, COMMIT, directory / "SHA256SUMS")

    def test_finalizer_rejects_duplicate_archive_member(self) -> None:
        directory, context = self.complete_temporary_release()
        with context:
            target = ("linux", "amd64")
            archive, record = self.archive_and_record(directory, *target)
            binary = fake_binary(*target)
            write_archive(archive, package_name(*target), "pomodorough", binary, duplicate=True)
            record["archive_sha256"] = sha256_path(archive)
            self.write_package_record(directory, target, record)
            rewrite_checksums(directory)
            with self.assertRaisesRegex(ValueError, "exactly one regular"):
                self.identity.verify_release(directory, TAG, COMMIT, directory / "SHA256SUMS")

    def test_finalizer_rejects_stale_checksum(self) -> None:
        directory, context = self.complete_temporary_release()
        with context:
            (directory / "pomodorough-server.spdx.json").write_text('{"mutated":true}\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "checksum manifest"):
                self.identity.verify_release(directory, TAG, COMMIT, directory / "SHA256SUMS")

    def test_finalizer_rejects_forged_package_identity(self) -> None:
        directory, context = self.complete_temporary_release()
        with context:
            target = ("darwin", "amd64")
            archive, record = self.archive_and_record(directory, *target)
            forged = fake_binary(*target, nonce=b"forged-package")
            write_archive(archive, package_name(*target), "pomodorough", forged)
            forged_hash = sha256_bytes(forged)
            record.update(archive_sha256=sha256_path(archive), archive_member_sha256=forged_hash, tested_binary_sha256=forged_hash)
            self.write_package_record(directory, target, record)
            rewrite_checksums(directory)
            with self.assertRaisesRegex(ValueError, "native-tested binary"):
                self.identity.verify_release(directory, TAG, COMMIT, directory / "SHA256SUMS")

    def test_finalizer_rejects_self_consistent_same_arch_forgery_after_native_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "release"
            trusted = root / "trusted-native-records"
            directory.mkdir()
            trusted.mkdir()
            ReleaseFixture(self.identity, directory).complete_release()
            for name in self.identity.native_record_asset_names(TAG):
                (trusted / name).write_bytes((directory / name).read_bytes())
            self.forge_complete_target(directory, "darwin", "amd64")
            rewrite_checksums(directory)
            with self.assertRaisesRegex(ValueError, "published native record differs"):
                self.identity.verify_release(
                    directory, TAG, COMMIT, directory / "SHA256SUMS", trusted
                )

    def test_finalizer_rejects_forged_native_record(self) -> None:
        directory, context = self.complete_temporary_release()
        with context:
            target = ("linux", "arm64")
            _, record = self.archive_and_record(directory, *target)
            native_path = directory / f"{package_name(*target)}.native.json"
            native = read_json(native_path)
            native["commit"] = "f" * 40
            write_json(native_path, native)
            record["native_record_sha256"] = sha256_path(native_path)
            self.write_package_record(directory, target, record)
            rewrite_checksums(directory)
            with self.assertRaisesRegex(ValueError, "native identity commit mismatch"):
                self.identity.verify_release(directory, TAG, COMMIT, directory / "SHA256SUMS")

    def test_finalizer_rejects_forged_final_archive_sha(self) -> None:
        directory, context = self.complete_temporary_release()
        with context:
            target = ("windows", "amd64")
            _, record = self.archive_and_record(directory, *target)
            record["archive_sha256"] = "0" * 64
            self.write_package_record(directory, target, record)
            rewrite_checksums(directory)
            with self.assertRaisesRegex(ValueError, "final archive differs"):
                self.identity.verify_release(directory, TAG, COMMIT, directory / "SHA256SUMS")

    def test_finalizer_rejects_same_arch_native_record_transplant(self) -> None:
        directory, context = self.complete_temporary_release()
        with context:
            source = directory / f"{package_name('linux', 'amd64')}.native.json"
            target = ("darwin", "amd64")
            transplanted = directory / f"{package_name(*target)}.native.json"
            transplanted.write_bytes(source.read_bytes())
            _, record = self.archive_and_record(directory, *target)
            record["native_record_sha256"] = sha256_path(transplanted)
            self.write_package_record(directory, target, record)
            rewrite_checksums(directory)
            with self.assertRaisesRegex(ValueError, "native identity target mismatch"):
                self.identity.verify_release(directory, TAG, COMMIT, directory / "SHA256SUMS")

    def test_finalizer_rejects_package_identity_transplant(self) -> None:
        directory, context = self.complete_temporary_release()
        with context:
            source = directory / f"{package_name('linux', 'amd64')}.identity.json"
            target = directory / f"{package_name('darwin', 'amd64')}.identity.json"
            target.write_bytes(source.read_bytes())
            rewrite_checksums(directory)
            with self.assertRaisesRegex(ValueError, "package identity target mismatch"):
                self.identity.verify_release(directory, TAG, COMMIT, directory / "SHA256SUMS")

    def test_workflow_matches_fixed_contract(self) -> None:
        self.assertEqual(workflow_contract_errors(self.workflow), [])

    def test_workflow_mutants_fail_closed(self) -> None:
        mutations = {
            "missing darwin build": self.workflow.replace(
                "          - goos: darwin\n            goarch: amd64\n            runner: macos-15-intel\n            binary: pomodorough\n", "", 1
            ),
            "missing darwin package": self.workflow.replace(
                "          - goos: darwin\n            goarch: amd64\n            binary: pomodorough\n", "", 1
            ),
            "missing darwin publication": self.workflow.replace(
                '            "pomodorough-${version}-darwin-amd64.native.json"\n', "", 1
            ),
            "post smoke": self.workflow.replace(
                "      - name: Attest immutable native test record",
                "      - name: Replace native binary after smoke\n        run: cp forged dist/native/pomodorough\n      - name: Attest immutable native test record",
                1,
            ),
            "mutable package source": self.workflow.replace("pattern: native-record-*", "pattern: pomodorough-*", 1),
            "missing native verify": self.workflow.replace("gh attestation verify \"$record\" --repo \"$GH_REPO\"", "true", 1),
            "post import": self.workflow.replace(
                "      - name: Finalize release identity and checksums",
                "      - name: Replace trusted native record\n        run: cp forged trusted-native-records/linux.native.json\n      - name: Finalize release identity and checksums",
                1,
            ),
            "post bind": self.workflow.replace(
                "      - name: Attest archive and identity binding",
                "      - name: Replace archive after bind\n        run: cp forged dist/archive.tar.gz\n      - name: Attest archive and identity binding",
                1,
            ),
        }
        for name, workflow in mutations.items():
            self.assertTrue(workflow_contract_errors(workflow), name)

    def test_go_test_requires_exact_version_bytes(self) -> None:
        source = GO_TEST_PATH.read_text(encoding="utf-8")
        self.assertIn('want := []byte(expected + "\\n")', source)
        self.assertIn("bytes.Equal(output, want)", source)
        self.assertNotIn("strings.TrimSpace(output)", source)

    def test_documentation_states_complete_contract(self) -> None:
        document = DOC_PATH.read_text(encoding="utf-8")
        normalized = " ".join(document.split())
        required = (
            "macOS amd64", "macOS arm64", "exactly one newline", ".native.json",
            "separate immutable", "independently trusted native test record",
            "All five", "checksummed public release assets", "immediately before checksums",
        )
        for phrase in required:
            self.assertIn(phrase, normalized)

    def complete_temporary_release(self) -> tuple[Path, tempfile.TemporaryDirectory]:
        context = tempfile.TemporaryDirectory()
        directory = Path(context.name)
        ReleaseFixture(self.identity, directory).complete_release()
        return directory, context

    def archive_and_record(self, directory: Path, goos: str, goarch: str) -> tuple[Path, dict[str, str]]:
        package = package_name(goos, goarch)
        archive = directory / f"{package}.tar.gz"
        record = read_json(directory / f"{package}.identity.json")
        return archive, record

    def write_package_record(self, directory: Path, target: tuple[str, str], record: dict[str, str]) -> None:
        write_json(directory / f"{package_name(*target)}.identity.json", record)

    def forge_complete_target(self, directory: Path, goos: str, goarch: str) -> None:
        target = (goos, goarch)
        archive, record = self.archive_and_record(directory, *target)
        native_path = directory / f"{package_name(*target)}.native.json"
        native = read_json(native_path)
        forged = fake_binary(*target, nonce=b"post-smoke-self-consistent-forgery")
        write_archive(archive, package_name(*target), native["binary"], forged)
        forged_hash = sha256_bytes(forged)
        native["binary_sha256"] = forged_hash
        write_json(native_path, native)
        record.update(
            archive_sha256=sha256_path(archive),
            archive_member_sha256=forged_hash,
            tested_binary_sha256=forged_hash,
            native_record_sha256=sha256_path(native_path),
        )
        self.write_package_record(directory, target, record)


if __name__ == "__main__":
    unittest.main()
