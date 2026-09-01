"""Verify integration credential documentation and workflow enforcement."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = (ROOT / "README.md").read_text(encoding="utf-8")
SECTION_HEADING = "### Integration user provisioning"
SECTION_SHA256 = "461a8a723340894d8f3af97e6048fa143480f74d42de925c482ad0ad523e16e1"
LEGACY_CREDENTIAL_PATH = "integration-credentials.json"
IGNORE_RULE = "/integration-credentials.json"
WORKFLOW_TEST_NAME = "Test integration credential documentation"
WORKFLOW_TEST_COMMAND = "python3 -m unittest scripts/test_integration_credential_docs.py -v"
ALLOWED_TARGET_JOB_KEYS = ("name", "runs-on", "timeout-minutes", "steps")
ALLOWED_WORKFLOW_KEYS = ("name", "on", "permissions", "concurrency", "jobs")
SENSITIVE_MARKERS = (
    "/tmp/pomodorough-integration-user",
    "POMODOROUGH_INTEGRATION_CREDENTIALS",
    LEGACY_CREDENTIAL_PATH,
)

EXPECTED_RECIPE = r"""umask 077
export POMODOROUGH_INTEGRATION_DATA_DIR="$(mktemp -d)"
export POMODOROUGH_INTEGRATION_APP_SECRET="$(openssl rand -hex 32)"
export POMODOROUGH_INTEGRATION_SUBJECT="integration-protocol-001"
export POMODOROUGH_INTEGRATION_DEVICES="pwa=device-pwa:web,ios=device-ios:ios,linux=device-linux:linux,android=device-android:android"
export POMODOROUGH_INTEGRATION_TTL="2h"
go build -o /tmp/pomodorough ./cmd/pomodorough
go build -tags=integration -o /tmp/pomodorough-integration-user ./cmd/pomodorough-integration-user
with_integration_credentials() (
  set -eu
  umask 077
  credential_directory=
  credential_directory_device=
  credential_directory_inode=
  credential_directory_open=
  credential_parent=
  POMODOROUGH_INTEGRATION_CREDENTIALS=
  credential_file_open=
  integration_command_status=
  integration_cleanup_status=
  python3_path="$(command -v python3)"
  cleanup_integration_credentials() {
    integration_command_status=$?
    trap - EXIT HUP INT TERM
    set +e
    integration_cleanup_status=0
    if [ "$credential_file_open" = 1 ]; then
      "$python3_path" -c 'import os; os.ftruncate(9, 0); os.fsync(9)' || integration_cleanup_status=1
      exec 9>&- || integration_cleanup_status=1
      credential_file_open=
    fi
    if [ "$credential_directory_open" = 1 ]; then
      "$python3_path" -c '
import os
import shutil
import stat
import sys
from pathlib import Path

expected = Path(sys.argv[1])
identity = (int(sys.argv[2]), int(sys.argv[3]))
opened = os.fstat(8)
if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != identity:
    raise SystemExit("opened credential directory identity changed")
if not shutil.rmtree.avoids_symlink_attacks:
    raise SystemExit("runtime cannot remove credential directory without symlink races")

def matches(path):
    try:
        current = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == identity

if not matches(expected):
    raise SystemExit("credential directory moved or replaced")

def remove_identity(path):
    os.chmod(path, 0o700, follow_symlinks=False)
    for root, directories, _ in os.walk(path, followlinks=False):
        os.chmod(root, 0o700, follow_symlinks=False)
        for directory in directories:
            child = Path(root, directory)
            if not child.is_symlink():
                os.chmod(child, 0o700, follow_symlinks=False)
    if not matches(path):
        raise SystemExit("credential directory identity changed during cleanup")
    shutil.rmtree(path)
    if os.path.lexists(path):
        raise SystemExit("credential directory removal was not conclusive")

remove_identity(expected)
' "$credential_directory" "$credential_directory_device" \
        "$credential_directory_inode" || integration_cleanup_status=1
      exec 8>&- || integration_cleanup_status=1
      credential_directory_open=
    elif [ -n "$credential_directory" ]; then
      integration_cleanup_status=1
    fi
    if [ "$integration_cleanup_status" -ne 0 ]; then
      printf '%s\n' 'secure integration credential cleanup failed' >&2
      exit 125
    fi
    if [ "$integration_command_status" -ne 0 ]; then
      exit "$integration_command_status"
    fi
    exit 0
  }
  trap cleanup_integration_credentials EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ "$#" -lt 2 ]; then
    printf '%s\n' 'usage: with_integration_credentials PROVISIONER TEST_COMMAND [ARG ...]' >&2
    return 2
  fi
  provisioner=$1
  shift
  repository_root="$(git rev-parse --show-toplevel)"
  credential_parent="$(
    "$python3_path" -c '
import os
import pathlib
import sys

repository = pathlib.Path(sys.argv[1]).resolve(strict=True)
for raw_candidate in ("/var/tmp", "/tmp"):
    candidate = pathlib.Path(raw_candidate).resolve(strict=True)
    if candidate != repository and repository not in candidate.parents:
        if os.access(candidate, os.W_OK | os.X_OK):
            print(candidate)
            raise SystemExit(0)
raise SystemExit("no writable temporary directory exists outside repository")
' "$repository_root"
  )"
  credential_directory="$(mktemp -d "$credential_parent/pomodorough-integration-credentials.XXXXXX")"
  POMODOROUGH_INTEGRATION_CREDENTIALS="$credential_directory/credentials.json"
  export POMODOROUGH_INTEGRATION_CREDENTIALS
  exec 8< "$credential_directory"
  credential_directory_open=1
  credential_directory_device="$("$python3_path" -c 'import os; print(os.fstat(8).st_dev)')"
  credential_directory_inode="$("$python3_path" -c 'import os; print(os.fstat(8).st_ino)')"
  chmod 700 "$credential_directory"
  : > "$POMODOROUGH_INTEGRATION_CREDENTIALS"
  chmod 600 "$POMODOROUGH_INTEGRATION_CREDENTIALS"
  exec 9<> "$POMODOROUGH_INTEGRATION_CREDENTIALS"
  credential_file_open=1
  # Stop dedicated integration server if already started.
  "$provisioner" >&9
  "$python3_path" -c '
import os
import stat
import sys

opened = os.fstat(9)
named = os.stat(sys.argv[1], follow_symlinks=False)
if not stat.S_ISREG(named.st_mode) or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
    raise SystemExit("credential path identity changed during provisioning")
if stat.S_IMODE(named.st_mode) != 0o600 or named.st_size == 0:
    raise SystemExit("credential file is empty or has unsafe permissions")
os.fsync(9)
' "$POMODOROUGH_INTEGRATION_CREDENTIALS"
  "$@"
)
with_integration_credentials /tmp/pomodorough-integration-user ./run-integration-protocol-tests"""


@dataclass(frozen=True)
class WorkflowContract:
    relative_path: str
    job_name: str
    trigger: str
    previous_step: str
    previous_command: str
    next_step: str
    next_command: str


WORKFLOW_CONTRACTS = (
    WorkflowContract(
        ".github/workflows/ci.yml",
        "server",
        "on:\n  push:\n  pull_request:\n",
        "Test shared-core provenance verifier",
        "python3 -m unittest scripts/test_shared_core_provenance.py -v",
        "Test with race detector",
        "go test -race ./...",
    ),
    WorkflowContract(
        ".github/workflows/release.yml",
        "verify",
        'on:\n  push:\n    tags:\n      - "v*"\n',
        "Test shared-core provenance verifier",
        "python3 -m unittest scripts/test_shared_core_provenance.py -v",
        "Test server with race detector",
        "go test -race ./...",
    ),
)

PROVISIONER_SCRIPT = r"""#!/usr/bin/env python3
import json
import os
import signal
import stat
import time
from pathlib import Path

credential = Path(os.environ["POMODOROUGH_INTEGRATION_CREDENTIALS"])
scenario = os.environ["POMODOROUGH_TEST_SCENARIO"]
if scenario == "provisioner-failure" or scenario.startswith("provisioner-"):
    capture = Path(os.environ["POMODOROUGH_TEST_CAPTURE"])
    capture.write_text(json.dumps({
        "path": str(credential),
        "mode": stat.S_IMODE(credential.stat().st_mode),
        "directory_mode": stat.S_IMODE(credential.parent.stat().st_mode),
        "file_uid": credential.stat().st_uid,
        "directory_uid": credential.parent.stat().st_uid,
    }), encoding="utf-8")
if scenario == "provisioner-empty":
    raise SystemExit(0)
print(json.dumps({"fixture": True}), flush=True)
if scenario == "provisioner-failure":
    raise SystemExit(29)
if scenario == "provisioner-permission-failure":
    credential.chmod(0)
    credential.parent.chmod(0)
    raise SystemExit(29)
if scenario == "provisioner-path-replacement":
    credential.unlink()
    credential.symlink_to(capture)
    raise SystemExit(29)
signals = {
    "provisioner-hup": signal.SIGHUP,
    "provisioner-int": signal.SIGINT,
    "provisioner-term": signal.SIGTERM,
}
if scenario in signals:
    os.kill(os.getppid(), signals[scenario])
    time.sleep(0.1)
"""

CLIENT_SCRIPT = r"""#!/usr/bin/env python3
import json
import os
import signal
import stat
import time
from pathlib import Path

credential = Path(os.environ["POMODOROUGH_INTEGRATION_CREDENTIALS"])
json.loads(credential.read_text(encoding="utf-8"))
capture = Path(os.environ["POMODOROUGH_TEST_CAPTURE"])
observation = {
    "path": str(credential),
    "mode": stat.S_IMODE(credential.stat().st_mode),
    "directory_mode": stat.S_IMODE(credential.parent.stat().st_mode),
    "file_uid": credential.stat().st_uid,
    "directory_uid": credential.parent.stat().st_uid,
}

def record(**values):
    observation.update(values)
    capture.write_text(json.dumps(observation), encoding="utf-8")

def relocate(label, nested=False, cross_parent=False):
    original = credential.parent
    relocation_root = original.parent
    if cross_parent:
        relocation_root = capture.parent
        if relocation_root.resolve() == original.parent.resolve():
            raise RuntimeError("cross-parent fixture did not change parent")
    relocation_parent = relocation_root / f".{original.name}.{label}.{os.getpid()}"
    destination_parent = relocation_parent / "nested" if nested else relocation_parent
    destination_parent.mkdir(parents=True, mode=0o700)
    moved = destination_parent / original.name
    original.rename(moved)
    record(moved_path=str(moved / credential.name), relocation_parent=str(relocation_parent))
    return original, moved, relocation_parent

record()
scenario = os.environ["POMODOROUGH_TEST_SCENARIO"]
if scenario == "client-permission-failure":
    credential.chmod(0)
    credential.parent.chmod(0)
    raise SystemExit(29)
if scenario == "client-symlink-failure":
    replacement = capture.parent / "replacement target"
    replacement.write_text("must survive", encoding="utf-8")
    credential.unlink()
    credential.symlink_to(replacement)
    record(replacement=str(replacement))
    raise SystemExit(29)
if scenario == "client-directory-replacement-failure":
    credential.unlink()
    credential.mkdir()
    nested = credential / "nested"
    nested.mkdir()
    (nested / "replacement").write_text("not a credential", encoding="utf-8")
    nested.chmod(0)
    raise SystemExit(29)
if scenario == "client-directory-rename-failure":
    moved = credential.parent.with_name(credential.parent.name + ".moved")
    credential.parent.rename(moved)
    record(moved_path=str(moved / credential.name))
    raise SystemExit(29)
if scenario == "client-cross-parent-rename-failure":
    _, _, relocation_parent = relocate("cross-parent", cross_parent=True)
    unrelated = relocation_parent / "must-not-delete"
    unrelated.write_text("unrelated", encoding="utf-8")
    record(unrelated=str(unrelated))
    raise SystemExit(29)
if scenario == "client-nested-rename-failure":
    _, _, relocation_parent = relocate("nested", nested=True)
    unrelated = relocation_parent / "must-not-delete"
    unrelated.write_text("unrelated", encoding="utf-8")
    record(unrelated=str(unrelated))
    raise SystemExit(29)
if scenario == "client-rename-back-failure":
    original, moved, relocation_parent = relocate("rename-back")
    moved.rename(original)
    relocation_parent.rmdir()
    record(moved_path=str(moved / credential.name), relocation_parent=str(relocation_parent))
    raise SystemExit(29)
if scenario == "client-directory-collision-failure":
    original, _, _ = relocate("collision")
    original.mkdir(mode=0o700)
    replacement = original / "must-not-delete"
    replacement.write_text("untrusted replacement", encoding="utf-8")
    record(replacement_directory=str(original), replacement_file=str(replacement))
    raise SystemExit(29)
if scenario == "client-inaccessible-relocation-failure":
    _, _, relocation_parent = relocate("inaccessible", nested=True)
    relocation_parent.chmod(0)
    raise SystemExit(29)
if scenario == "client-inaccessible-relocation-term":
    _, _, relocation_parent = relocate("signal", nested=True)
    relocation_parent.chmod(0)
    os.kill(os.getppid(), signal.SIGTERM)
    time.sleep(0.1)
if scenario == "client-identity-symlink-alias-failure":
    alias = credential.parent.with_name(credential.parent.name + ".alias")
    alias.symlink_to(credential.parent, target_is_directory=True)
    record(alias=str(alias))
    raise SystemExit(29)
if scenario == "client-hardlink-failure":
    credential_link = credential.parent.with_name(
        credential.parent.name + ".credential-link"
    )
    os.link(credential, credential_link)
    record(credential_link=str(credential_link))
    raise SystemExit(29)
signals = {
    "client-hup": signal.SIGHUP,
    "client-int": signal.SIGINT,
    "client-term": signal.SIGTERM,
}
if scenario == "client-failure":
    raise SystemExit(29)
if scenario in signals:
    os.kill(os.getppid(), signals[scenario])
    time.sleep(0.1)
"""


def integration_section(readme: str) -> str:
    pattern = re.compile(
        rf"(?ms)^{re.escape(SECTION_HEADING)}\n(?P<section>.*?)(?=^##(?:#)? |\Z)"
    )
    matches = list(pattern.finditer(readme))
    if len(matches) != 1:
        raise AssertionError(f"expected one integration section, found {len(matches)}")
    return matches[0].group("section")


def executable_fences(section: str) -> list[tuple[str, str]]:
    pattern = re.compile(
        r"(?ms)^```(?P<language>[A-Za-z0-9_-]+)\n(?P<body>.*?)^```[ \t]*$"
    )
    fences = [
        (match.group("language"), match.group("body").removesuffix("\n"))
        for match in pattern.finditer(section)
    ]
    if section.count("```") != len(fences) * 2:
        raise AssertionError("integration section contains malformed or untyped code fence")
    return fences


def validate_readme_contract(readme: str) -> str:
    section = integration_section(readme)
    digest = hashlib.sha256(section.encode()).hexdigest()
    if digest != SECTION_SHA256:
        raise AssertionError("integration section differs from reviewed content")
    fences = executable_fences(section)
    if fences != [("bash", EXPECTED_RECIPE)]:
        raise AssertionError("integration section must contain only approved Bash recipe")
    if LEGACY_CREDENTIAL_PATH in EXPECTED_RECIPE:
        raise AssertionError("approved recipe writes legacy repository credential path")
    reviewed = f"{SECTION_HEADING}\n{section}"
    remainder = readme.replace(reviewed, "", 1)
    if any(marker in remainder for marker in SENSITIVE_MARKERS):
        raise AssertionError("integration credential instructions escaped reviewed section")
    return fences[0][1]


def workflow_job(workflow: str, name: str) -> str:
    pattern = re.compile(
        rf"(?ms)^  {re.escape(name)}:\n(?P<body>.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)"
    )
    matches = list(pattern.finditer(workflow))
    if len(matches) != 1:
        raise AssertionError(f"expected one {name} workflow job")
    return matches[0].group("body")


def expected_workflow_block(contract: WorkflowContract) -> str:
    return "\n".join(
        (
            f"      - name: {contract.previous_step}",
            f"        run: {contract.previous_command}",
            f"      - name: {WORKFLOW_TEST_NAME}",
            f"        run: {WORKFLOW_TEST_COMMAND}",
            f"      - name: {contract.next_step}",
            f"        run: {contract.next_command}",
        )
    )


def validate_target_job_keys(job: str) -> None:
    keys: list[str] = []
    for line in job.splitlines():
        if not line.startswith("    ") or line.startswith("     "):
            continue
        match = re.fullmatch(r"    ([A-Za-z][A-Za-z0-9_-]*):(?: .*)?", line)
        if match is None:
            raise AssertionError("target job contains unsupported YAML mapping syntax")
        keys.append(match.group(1))
    if tuple(keys) != ALLOWED_TARGET_JOB_KEYS:
        raise AssertionError("target job contains a bypass-capable or unexpected key")


def validate_workflow_keys(workflow: str) -> None:
    keys: list[str] = []
    for line in workflow.splitlines():
        if not line or line.startswith((" ", "#")):
            continue
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9_-]*):(?: .*)?", line)
        if match is None:
            raise AssertionError("workflow contains unsupported top-level YAML syntax")
        keys.append(match.group(1))
    if tuple(keys) != ALLOWED_WORKFLOW_KEYS:
        raise AssertionError("workflow contains a bypass-capable or unexpected key")


def validate_workflow_job_names(workflow: str) -> None:
    lines = workflow.splitlines()
    jobs_indexes = [index for index, line in enumerate(lines) if line == "jobs:"]
    if len(jobs_indexes) != 1:
        raise AssertionError("workflow must contain one exact jobs mapping")
    names: list[str] = []
    for line in lines[jobs_indexes[0] + 1 :]:
        if not line.startswith("  ") or line.startswith("   "):
            continue
        match = re.fullmatch(r"  ([A-Za-z][A-Za-z0-9_-]*):", line)
        if match is None:
            raise AssertionError("workflow job contains unsupported YAML key syntax")
        names.append(match.group(1))
    if len(names) != len(set(names)):
        raise AssertionError("workflow job names must be unique")


def validate_workflow_contract(workflow: str, contract: WorkflowContract) -> None:
    validate_workflow_keys(workflow)
    validate_workflow_job_names(workflow)
    if workflow.count(contract.trigger) != 1:
        raise AssertionError("workflow trigger differs from reviewed invocation")
    job = workflow_job(workflow, contract.job_name)
    validate_target_job_keys(job)
    expected = expected_workflow_block(contract)
    if job.count(expected) != 1:
        raise AssertionError("credential documentation test is not exact and ordered")
    if job.count(f"- name: {WORKFLOW_TEST_NAME}") != 1:
        raise AssertionError("credential documentation test step must be unique")
    if workflow.count(WORKFLOW_TEST_COMMAND) != 1:
        raise AssertionError("credential documentation test command must be unique")


def git_check_ignore(repository: Path, relative_path: str) -> bool:
    result = subprocess.run(
        ["git", "check-ignore", "-q", "--", relative_path],
        cwd=repository,
        check=False,
    )
    return result.returncode == 0


def validate_gitignore(contents: str) -> None:
    if contents.splitlines().count(IGNORE_RULE) != 1:
        raise AssertionError("exact root legacy credential ignore must appear once")
    with tempfile.TemporaryDirectory(prefix="credential-ignore-") as directory:
        repository = Path(directory)
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        (repository / ".gitignore").write_text(contents, encoding="utf-8")
        root = git_check_ignore(repository, LEGACY_CREDENTIAL_PATH)
        nested = git_check_ignore(repository, f"nested/{LEGACY_CREDENTIAL_PATH}")
    if not root or nested:
        raise AssertionError("legacy ignore must affect only repository-root file")


def helper_definition(recipe: str) -> str:
    start = recipe.index("with_integration_credentials() (")
    end = recipe.index("\nwith_integration_credentials /tmp/", start)
    return recipe[start:end]


def write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def fixture_environment(work: Path, scenario: str) -> tuple[dict[str, str], Path, Path]:
    capture = work / "capture file\n.json"
    marker = work / "mktemp marker\n.txt"
    hostile_tmpdir = work / "hostile TMPDIR symlink\n"
    hostile_tmpdir.symlink_to(ROOT, target_is_directory=True)
    environment = os.environ.copy()
    environment.update(
        TMPDIR=str(hostile_tmpdir),
        POMODOROUGH_INTEGRATION_CREDENTIALS=str(
            ROOT / "nested" / ".." / LEGACY_CREDENTIAL_PATH
        ),
        POMODOROUGH_TEST_CAPTURE=str(capture),
        POMODOROUGH_MKTEMP_MARKER=str(marker),
        POMODOROUGH_TEST_SCENARIO=scenario,
    )
    return environment, capture, marker


def captured_observation(capture: Path, marker: Path) -> tuple[dict[str, object], Path | None]:
    observation: dict[str, object] = {}
    credential_path: Path | None = None
    if capture.exists():
        observation.update(json.loads(capture.read_text(encoding="utf-8")))
        credential_path = Path(str(observation["path"]))
    elif marker.exists():
        credential_path = Path(marker.read_text(encoding="utf-8")) / "credentials.json"
        observation["path"] = str(credential_path)
    if "relocation_parent" in observation:
        relocation_parent = Path(str(observation["relocation_parent"]))
        if relocation_parent.exists():
            relocation_parent.chmod(0o700)
    if credential_path is not None:
        observation["file_exists_after"] = os.path.lexists(credential_path)
        observation["directory_exists_after"] = os.path.lexists(credential_path.parent)
        if credential_path.exists() and not credential_path.is_symlink():
            observation["file_size_after"] = credential_path.stat().st_size
    if "replacement" in observation:
        replacement = Path(str(observation["replacement"]))
        observation["replacement_exists_after"] = replacement.exists()
        observation["replacement_content_after"] = replacement.read_text(encoding="utf-8")
    if "moved_path" in observation:
        moved_path = Path(str(observation["moved_path"]))
        observation["moved_exists_after"] = os.path.lexists(moved_path)
        observation["moved_size_after"] = moved_path.stat().st_size if moved_path.exists() else None
    if "replacement_directory" in observation:
        replacement = Path(str(observation["replacement_directory"]))
        replacement_file = Path(str(observation["replacement_file"]))
        observation["replacement_directory_exists_after"] = os.path.lexists(replacement)
        observation["replacement_file_exists_after"] = replacement_file.exists()
        if replacement_file.exists():
            observation["replacement_file_content_after"] = replacement_file.read_text(
                encoding="utf-8"
            )
    if "alias" in observation:
        alias = Path(str(observation["alias"]))
        observation["alias_exists_after"] = os.path.lexists(alias)
        observation["alias_target_exists_after"] = alias.exists()
    if "credential_link" in observation:
        credential_link = Path(str(observation["credential_link"]))
        observation["credential_link_exists_after"] = os.path.lexists(credential_link)
        if credential_link.exists():
            observation["credential_link_size_after"] = credential_link.stat().st_size
    if "unrelated" in observation:
        unrelated = Path(str(observation["unrelated"]))
        observation["unrelated_exists_after"] = unrelated.exists()
        if unrelated.exists():
            observation["unrelated_content_after"] = unrelated.read_text(encoding="utf-8")
    return observation, credential_path


def remove_leaked_fixture(
    credential_path: Path | None, observation: dict[str, object]
) -> None:
    candidates = [credential_path]
    if "moved_path" in observation:
        candidates.append(Path(str(observation["moved_path"])))
    for candidate in candidates:
        if candidate is None or not os.path.lexists(candidate.parent):
            continue
        if candidate.parent.name.startswith("pomodorough-integration-credentials."):
            candidate.parent.chmod(0o700)
            shutil.rmtree(candidate.parent)
    for key in ("alias", "credential_link"):
        if key in observation:
            path = Path(str(observation[key]))
            if os.path.lexists(path):
                path.unlink()
    if "relocation_parent" in observation:
        relocation_parent = Path(str(observation["relocation_parent"]))
        if relocation_parent.exists():
            relocation_parent.chmod(0o700)
            shutil.rmtree(relocation_parent)


def exercise_helper(
    scenario: str, prefix: str = ""
) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
    with tempfile.TemporaryDirectory(prefix="credential-docs-") as directory:
        work = Path(directory)
        provisioner = work / "provisioner tool\n"
        client = work / "client tool\n"
        write_executable(provisioner, PROVISIONER_SCRIPT)
        write_executable(client, CLIENT_SCRIPT)
        environment, capture, marker = fixture_environment(work, scenario)
        invocation = 'with_integration_credentials "$1" "$2"'
        command = "\n".join(filter(None, (prefix, helper_definition(EXPECTED_RECIPE), invocation)))
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c", command, "contract", str(provisioner), str(client)],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        observation, credential_path = captured_observation(capture, marker)
        remove_leaked_fixture(credential_path, observation)
        return result, observation


def exercise_readonly_collision(variable: str) -> tuple[int, bool]:
    with tempfile.TemporaryDirectory(prefix="credential-collision-") as directory:
        work = Path(directory)
        recipe = work / "recipe.sh"
        provisioner = work / "provisioner"
        client = work / "client"
        recipe.write_text(
            f'{helper_definition(EXPECTED_RECIPE)}\nwith_integration_credentials "$1" "$2"\n',
            encoding="utf-8",
        )
        write_executable(provisioner, PROVISIONER_SCRIPT)
        write_executable(client, CLIENT_SCRIPT)
        environment, _, marker = fixture_environment(work, "success")
        runner = rf'''mktemp() {{
  printf called > "$POMODOROUGH_MKTEMP_MARKER"
  command mktemp "$@"
}}
readonly {variable}=occupied
source "$1" "$2" "$3"'''
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c", runner, "contract", str(recipe), str(provisioner), str(client)],
            cwd=ROOT, env=environment, capture_output=True, text=True, timeout=10, check=False,
        )
        return result.returncode, marker.exists()


def assert_protected_observation(
    test: unittest.TestCase, observation: dict[str, object]
) -> None:
    path = Path(str(observation["path"])).resolve()
    test.assertNotEqual(path, ROOT.resolve())
    test.assertNotIn(ROOT.resolve(), path.parents)
    test.assertEqual(observation["mode"], 0o600)
    test.assertEqual(observation["directory_mode"], 0o700)
    test.assertEqual(observation["file_uid"], os.getuid())
    test.assertEqual(observation["directory_uid"], os.getuid())


def assert_safe_observation(test: unittest.TestCase, observation: dict[str, object]) -> None:
    assert_protected_observation(test, observation)
    test.assertFalse(observation["file_exists_after"])
    test.assertFalse(observation["directory_exists_after"])
    if "replacement" in observation:
        test.assertTrue(observation["replacement_exists_after"])
        test.assertEqual(observation["replacement_content_after"], "must survive")
    if "moved_path" in observation:
        test.assertFalse(observation["moved_exists_after"])
    if "credential_link" in observation:
        test.assertTrue(observation["credential_link_exists_after"])
        test.assertEqual(observation["credential_link_size_after"], 0)


def assert_unresolved_relocation(
    test: unittest.TestCase, observation: dict[str, object]
) -> None:
    assert_protected_observation(test, observation)
    test.assertFalse(observation["file_exists_after"])
    if "replacement_directory" in observation:
        test.assertTrue(observation["directory_exists_after"])
    else:
        test.assertFalse(observation["directory_exists_after"])
    test.assertTrue(observation["moved_exists_after"])
    test.assertEqual(observation["moved_size_after"], 0)
    if "unrelated" in observation:
        test.assertTrue(observation["unrelated_exists_after"])
        test.assertEqual(observation["unrelated_content_after"], "unrelated")


def transformed_document_mutations(readme: str, anchor: str) -> dict[str, str]:
    return {
        "approved fence changed to sh": readme.replace("```bash\n", "```sh\n", 1),
        "duplicate approved fence": readme.replace(
            anchor, f"\n```bash\n{EXPECTED_RECIPE}\n```\n{anchor}", 1
        ),
        "indented executable recipe": readme.replace(
            anchor,
            "\n    /tmp/pomodorough-integration-user > integration-credentials.json\n"
            f"{anchor}",
            1,
        ),
        "blockquote executable recipe": readme.replace(
            anchor,
            "\n> /tmp/pomodorough-integration-user > integration-credentials.json\n"
            f"{anchor}",
            1,
        ),
        "html comment executable recipe": readme.replace(
            anchor,
            "\n<!-- /tmp/pomodorough-integration-user > integration-credentials.json -->\n"
            f"{anchor}",
            1,
        ),
    }


def document_mutations(readme: str) -> dict[str, str]:
    anchor = "\nLegacy repository-local integration-credentials.json storage is unsafe"
    snippets = {
        "reordered shell aliases": '```sh\nsuffix=json\nmiddle=credentials\nprefix=integration\ncp /tmp/live "$prefix-$middle.$suffix"\n```\n',
        "python assignments": '```python\nsuffix="json"\nname=f"integration-credentials.{suffix}"\nopen(name, "w").write(secret)\n```\n',
        "powershell interpolation": '```powershell\n$suffix="json"\n$name="integration-credentials.$suffix"\nCopy-Item /tmp/live $name\n```\n',
        "indirect unknown sink": '```sh\ndestination="$UNREVIEWED_DESTINATION"\ncp /tmp/live "$destination"\n```\n',
        "comment lookalike": '```sh\n# cp /tmp/live integration-credentials.json\n```\n',
        "string lookalike": '```python\nexample = "cp /tmp/live integration-credentials.json"\n```\n',
    }
    mutations = {
        name: readme.replace(anchor, f"\n{snippet}{anchor}", 1)
        for name, snippet in snippets.items()
    }
    production_heading = "## Production deployment\n"
    escaped_snippets = {
        name: snippet
        for name, snippet in snippets.items()
        if any(marker in snippet for marker in SENSITIVE_MARKERS)
    }
    mutations.update(
        {
            f"{name} outside reviewed section": readme.replace(
                production_heading, f"{production_heading}\n{snippet}", 1
            )
            for name, snippet in escaped_snippets.items()
        }
    )
    mutations["recipe outside reviewed section"] = readme.replace(
        production_heading,
        production_heading
        + '\n```sh\n/tmp/pomodorough-integration-user > "$UNKNOWN"\n```\n',
        1,
    )
    mutations.update(transformed_document_mutations(readme, anchor))
    return mutations


def extended_workflow_mutations(
    workflow: str, contract: WorkflowContract, target: str
) -> dict[str, str]:
    job = f"  {contract.job_name}:\n"
    return {
        "job continue on error expression": workflow.replace(
            job, f"{job}    continue-on-error: ${{{{ true }}}}\n", 1
        ),
        "quoted job condition": workflow.replace(
            job, f'{job}    "if": ${{{{ false }}}}\n', 1
        ),
        "job needs skipped dependency": workflow.replace(
            job, f"{job}    needs: missing\n", 1
        ),
        "job permissions": workflow.replace(job, f"{job}    permissions: {{}}\n", 1),
        "job merge alias": workflow.replace(
            "jobs:\n", "x-job: &skip-job {continue-on-error: true}\njobs:\n", 1
        ).replace(job, f"{job}    <<: *skip-job\n", 1),
        "step continue on error expression": workflow.replace(
            target, f"{target}\n        continue-on-error: ${{{{ true }}}}", 1
        ),
        "step timeout": workflow.replace(target, f"{target}\n        timeout-minutes: 1", 1),
        "step merge alias": workflow.replace(
            "jobs:\n", "x-step: &skip-step {continue-on-error: true}\njobs:\n", 1
        ).replace(target, f"{target}\n        <<: *skip-step", 1),
        "flow command replacement": workflow.replace(
            f"run: {WORKFLOW_TEST_COMMAND}",
            f"run: >-\n          {WORKFLOW_TEST_COMMAND} || true",
            1,
        ),
        "duplicate target in other job": workflow.replace(
            "jobs:\n", f"jobs:\n  shadow:\n    steps:\n{target}\n", 1
        ),
        "workflow environment": workflow.replace(
            "jobs:\n", "env:\n  PYTHONPATH: /tmp\njobs:\n", 1
        ),
        "duplicate trigger key": workflow.replace("name:", "on: {}\nname:", 1),
    }


def workflow_mutations(workflow: str, contract: WorkflowContract) -> dict[str, str]:
    block = expected_workflow_block(contract)
    target = f"      - name: {WORKFLOW_TEST_NAME}\n        run: {WORKFLOW_TEST_COMMAND}"
    reordered = block.replace(
        f"{target}\n      - name: {contract.next_step}",
        f"      - name: {contract.next_step}\n        run: {contract.next_command}\n{target}",
    )
    mutations = {
        "waived command": workflow.replace(WORKFLOW_TEST_COMMAND, f"{WORKFLOW_TEST_COMMAND} || true", 1),
        "step condition": workflow.replace(target, target.replace("\n        run:", "\n        if: ${{ false }}\n        run:"), 1),
        "step continue on error": workflow.replace(target, f"{target}\n        continue-on-error: true", 1),
        "step environment": workflow.replace(target, target.replace("\n        run:", "\n        env:\n          PYTHONPATH: /tmp\n        run:"), 1),
        "step shell": workflow.replace(target, target.replace("\n        run:", "\n        shell: bash -c 'exit 0' -- {{0}}\n        run:"), 1),
        "reordered step": workflow.replace(block, reordered, 1),
        "duplicate step": workflow.replace(target, f"{target}\n{target}", 1),
        "job condition": workflow.replace(f"  {contract.job_name}:\n", f"  {contract.job_name}:\n    if: ${{{{ false }}}}\n", 1),
        "job continue on error": workflow.replace(f"  {contract.job_name}:\n", f"  {contract.job_name}:\n    continue-on-error: true\n", 1),
        "quoted job continue on error": workflow.replace(f"  {contract.job_name}:\n", f"  {contract.job_name}:\n    \"continue-on-error\": true\n", 1),
        "job defaults": workflow.replace(f"  {contract.job_name}:\n", f"  {contract.job_name}:\n    defaults:\n      run:\n        shell: bash\n", 1),
        "job environment": workflow.replace(f"  {contract.job_name}:\n", f"  {contract.job_name}:\n    env:\n      PYTHONPATH: /tmp\n", 1),
        "job container": workflow.replace(f"  {contract.job_name}:\n", f"  {contract.job_name}:\n    container: attacker/image\n", 1),
        "job strategy": workflow.replace(f"  {contract.job_name}:\n", f"  {contract.job_name}:\n    strategy:\n      matrix:\n        include: []\n", 1),
        "workflow shell": workflow.replace("jobs:\n", "defaults:\n  run:\n    shell: bash\n\njobs:\n", 1),
        "inline workflow shell": workflow.replace("jobs:\n", "defaults: {run: {shell: bash}}\njobs:\n", 1),
        "quoted workflow shell": workflow.replace("jobs:\n", "\"defaults\":\n  run:\n    shell: bash\n\njobs:\n", 1),
        "workflow condition": workflow.replace("jobs:\n", "if: ${{ false }}\njobs:\n", 1),
        "workflow continue on error": workflow.replace(
            "jobs:\n", "continue-on-error: true\njobs:\n", 1
        ),
        "shadow jobs": workflow.replace("jobs:\n", "jobs: {}\njobs:\n", 1),
        "quoted duplicate target job": workflow.replace(
            f"  {contract.job_name}:\n", f'  "{contract.job_name}":\n    runs-on: ubuntu-latest\n  {contract.job_name}:\n', 1
        ),
        "spaced duplicate target job": workflow.replace(
            f"  {contract.job_name}:\n", f"  {contract.job_name} :\n    runs-on: ubuntu-latest\n  {contract.job_name}:\n", 1
        ),
        "aliased test command": workflow.replace(
            WORKFLOW_TEST_COMMAND, f"command {WORKFLOW_TEST_COMMAND}", 1
        ),
        "disabled trigger": workflow.replace(contract.trigger, "on:\n  workflow_dispatch:\n", 1),
    }
    mutations.update(extended_workflow_mutations(workflow, contract, target))
    return mutations


class IntegrationCredentialDocumentationTests(unittest.TestCase):
    def test_readme_uses_only_reviewed_executable_recipe(self) -> None:
        recipe = validate_readme_contract(README)
        self.assertEqual(recipe, EXPECTED_RECIPE)
        result = subprocess.run(
            ["bash", "-n"], input=recipe, text=True, capture_output=True, check=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unreviewed_cross_language_snippets_fail_closed(self) -> None:
        for name, mutation in document_mutations(README).items():
            with self.subTest(name=name), self.assertRaises(AssertionError):
                validate_readme_contract(mutation)

    def test_unrelated_readme_sections_do_not_change_contract(self) -> None:
        production_heading = "## Production deployment\n"
        unrelated = README.replace(
            production_heading,
            f"{production_heading}\nUnrelated deployment guidance.\n",
            1,
        )
        self.assertEqual(validate_readme_contract(unrelated), EXPECTED_RECIPE)

    def test_credential_sentinels_cannot_escape_reviewed_section(self) -> None:
        production_heading = "## Production deployment\n"
        for marker in SENSITIVE_MARKERS:
            escaped = README.replace(
                production_heading,
                f"{production_heading}\n{marker}\n",
                1,
            )
            with self.subTest(marker=marker), self.assertRaisesRegex(
                AssertionError, "escaped reviewed section"
            ):
                validate_readme_contract(escaped)

    def test_documented_trust_boundary_is_bounded(self) -> None:
        section = integration_section(README)
        prose = " ".join(section.split())
        self.assertIn("must finish their child processes before returning", prose)
        self.assertIn("must not leave a same-account process racing cleanup", prose)
        self.assertIn("not deliberate credential exfiltration", prose)
        self.assertIn("returns status `125` instead", prose)
        self.assertIn("Cross-filesystem copy-and-delete", prose)
        self.assertIn("does not search for or remove a moved directory", prose)
        self.assertIn("zero-length credential file for manual removal", prose)
        self.assertIn("non-identity replacement at the original directory path", prose)
        self.assertIn("remains inside its removal scope", prose)
        self.assertIn("Any rename away from the original generated path", prose)
        self.assertIn("clean, non-interactive Bash process", prose)
        self.assertIn("without inherited functions replacing", prose)

    def test_success_uses_protected_external_path_and_cleans(self) -> None:
        result, observation = exercise_helper("success")
        self.assertEqual(result.returncode, 0, result.stderr)
        assert_safe_observation(self, observation)

    def test_empty_provisioner_output_fails_and_cleans(self) -> None:
        result, observation = exercise_helper("provisioner-empty")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("credential file is empty", result.stderr)
        assert_safe_observation(self, observation)

    def test_failures_preserve_status_and_cleanup(self) -> None:
        scenarios = (
            "provisioner-failure",
            "provisioner-permission-failure",
            "provisioner-path-replacement",
            "client-failure",
            "client-permission-failure",
            "client-symlink-failure",
            "client-directory-replacement-failure",
            "client-rename-back-failure",
            "client-identity-symlink-alias-failure",
            "client-hardlink-failure",
        )
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                result, observation = exercise_helper(scenario)
                self.assertEqual(result.returncode, 29, result.stderr)
                assert_safe_observation(self, observation)

    def test_cleanup_failure_overrides_command_status(self) -> None:
        prefix = r'''python3() {
  case "$1:$2" in
    *:import\ os\;\ os.ftruncate*) return 75 ;;
  esac
  command python3 "$@"
}'''
        success, success_observation = exercise_helper("success", prefix)
        self.assertEqual(success.returncode, 125, success.stderr)
        self.assertIn("secure integration credential cleanup failed", success.stderr)
        assert_safe_observation(self, success_observation)
        failed, failed_observation = exercise_helper("client-failure", prefix)
        self.assertEqual(failed.returncode, 125, failed.stderr)
        self.assertIn("secure integration credential cleanup failed", failed.stderr)
        assert_safe_observation(self, failed_observation)

    def test_wipe_failure_leaves_observable_bytes_and_fails_closed(self) -> None:
        prefix = r'''python3() {
  case "$1:$2" in
    *:import\ os\;\ os.ftruncate*) return 75 ;;
  esac
  command python3 "$@"
}'''
        result, observation = exercise_helper("client-hardlink-failure", prefix)
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertIn("secure integration credential cleanup failed", result.stderr)
        self.assertFalse(observation["file_exists_after"])
        self.assertFalse(observation["directory_exists_after"])
        self.assertTrue(observation["credential_link_exists_after"])
        self.assertGreater(observation["credential_link_size_after"], 0)

    def test_directory_cleanup_failure_leaves_only_wiped_credential(self) -> None:
        prefix = r'''python3() {
  if [ "$1" = -c ] && [[ "$2" = *"import shutil"* ]]; then
    return 76
  fi
  command python3 "$@"
}'''
        for scenario in ("success", "client-failure"):
            with self.subTest(scenario=scenario):
                result, observation = exercise_helper(scenario, prefix)
                self.assertEqual(result.returncode, 125, result.stderr)
                self.assertIn("secure integration credential cleanup failed", result.stderr)
                self.assertTrue(observation["file_exists_after"])
                self.assertTrue(observation["directory_exists_after"])
                self.assertEqual(observation["file_size_after"], 0)

    def test_unresolved_directory_cleanup_fails_closed(self) -> None:
        scenarios = (
            "client-directory-rename-failure",
            "client-cross-parent-rename-failure",
            "client-nested-rename-failure",
            "client-directory-collision-failure",
            "client-inaccessible-relocation-failure",
            "client-inaccessible-relocation-term",
        )
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                result, observation = exercise_helper(scenario)
                self.assertEqual(result.returncode, 125, result.stderr)
                self.assertIn("secure integration credential cleanup failed", result.stderr)
                assert_unresolved_relocation(self, observation)
                if "replacement_directory" in observation:
                    self.assertTrue(observation["replacement_directory_exists_after"])
                    self.assertTrue(observation["replacement_file_exists_after"])
                    self.assertEqual(
                        observation["replacement_file_content_after"],
                        "untrusted replacement",
                    )

    def test_identity_symlink_alias_is_not_followed_or_deleted(self) -> None:
        result, observation = exercise_helper("client-identity-symlink-alias-failure")
        self.assertEqual(result.returncode, 29, result.stderr)
        assert_safe_observation(self, observation)
        self.assertTrue(observation["alias_exists_after"])
        self.assertFalse(observation["alias_target_exists_after"])

    def test_signals_preserve_status_and_cleanup(self) -> None:
        scenarios = tuple(
            (f"{actor}-{name}", status)
            for actor in ("provisioner", "client")
            for name, status in (("hup", 129), ("int", 130), ("term", 143))
        )
        for scenario, status in scenarios:
            with self.subTest(scenario=scenario):
                result, observation = exercise_helper(scenario)
                self.assertEqual(result.returncode, status, result.stderr)
                assert_safe_observation(self, observation)

    def test_failure_after_allocation_cleans_directory(self) -> None:
        prefix = r'''mktemp() {
  created_directory="$(command mktemp "$@")" || return
  printf '%s' "$created_directory" > "$POMODOROUGH_MKTEMP_MARKER"
  printf '%s\n' "$created_directory"
}
chmod() { return 29; }'''
        result, observation = exercise_helper("success", prefix)
        self.assertEqual(result.returncode, 29, result.stderr)
        path = Path(str(observation["path"])).resolve()
        self.assertNotIn(ROOT.resolve(), path.parents)
        self.assertFalse(observation["file_exists_after"])
        self.assertFalse(observation["directory_exists_after"])

    def test_readonly_collision_cannot_allocate_credentials(self) -> None:
        variables = (
            "credential_directory",
            "credential_directory_device",
            "credential_directory_inode",
            "credential_directory_open",
            "credential_parent",
            "POMODOROUGH_INTEGRATION_CREDENTIALS",
            "credential_file_open",
            "integration_command_status",
            "integration_cleanup_status",
            "python3_path",
        )
        for variable in variables:
            with self.subTest(variable=variable):
                returncode, mktemp_called = exercise_readonly_collision(variable)
                self.assertNotEqual(returncode, 0)
                self.assertFalse(mktemp_called)

    def test_gitignore_uses_exact_root_legacy_rule(self) -> None:
        contents = (ROOT / ".gitignore").read_text(encoding="utf-8")
        validate_gitignore(contents)
        with self.assertRaises(AssertionError):
            validate_gitignore(f"{contents}!{IGNORE_RULE}\n")

    def test_workflows_run_contract_in_exact_position(self) -> None:
        for contract in WORKFLOW_CONTRACTS:
            workflow = (ROOT / contract.relative_path).read_text(encoding="utf-8")
            with self.subTest(workflow=contract.relative_path):
                validate_workflow_contract(workflow, contract)

    def test_workflow_bypasses_fail_closed(self) -> None:
        for contract in WORKFLOW_CONTRACTS:
            workflow = (ROOT / contract.relative_path).read_text(encoding="utf-8")
            for name, mutation in workflow_mutations(workflow, contract).items():
                with self.subTest(workflow=contract.relative_path, mutation=name):
                    with self.assertRaises(AssertionError):
                        validate_workflow_contract(mutation, contract)


if __name__ == "__main__":
    unittest.main()
