#!/usr/bin/env python3
"""ID-bound server release publication.

GitHub has no atomic compare-and-publish PATCH covering a release, assets and tag.
Restrict contents:write to this workflow, protect release tags against update/delete,
and enable immutable releases. Workflow concurrency does not lock external writers.
Checks detect observed races, not every transient change between requests. Failure
after PATCH may leave a public release requiring incident response; never auto-delete
or retry publication. Reruns must not adopt, overwrite or republish existing releases.
The local seal is trusted runner state, not a signature against a compromised runner.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

from release_identity import ReleaseContract, sha256_bytes, validate_source, git_commit, verify_release


def gh_api(endpoint, *arguments, binary=False):
    result = subprocess.run(
        ["gh", "api", endpoint, *arguments], check=True, capture_output=True,
    )
    return result.stdout if binary else json.loads(result.stdout)


def identity():
    contract = ReleaseContract(
        os.environ["GITHUB_REF_NAME"], os.environ["GITHUB_WORKFLOW_SHA"],
        os.environ["GITHUB_SHA"], os.environ["GITHUB_REF"],
        os.environ["GITHUB_WORKFLOW_REF"], os.environ["GITHUB_REPOSITORY"],
    )
    validate_source(contract, git_commit)
    return dict(repository=contract.repository, tag=contract.tag, commit=contract.event_sha,
                workflow_sha=contract.workflow_sha, run=os.environ["GITHUB_RUN_ID"],
                attempt=os.environ["GITHUB_RUN_ATTEMPT"])


def remote_tag(bound):
    root = f"repos/{bound['repository']}/git"
    obj = gh_api(f"{root}/ref/tags/{quote(bound['tag'], safe='')}")["object"]
    for _ in range(16):
        if obj["type"] == "commit" and obj["sha"] == bound["commit"]:
            return
        if obj["type"] != "tag":
            break
        obj = gh_api(f"{root}/tags/{obj['sha']}")["object"]
    raise ValueError("remote tag no longer resolves to verified source")


def positive_id(value):
    if type(value) is not int or value <= 0:
        raise ValueError("invalid GitHub ID")
    return value


def release_state(bound, release_id):
    root = f"repos/{bound['repository']}/releases/{positive_id(release_id)}"
    release = gh_api(root)
    pages = gh_api(f"{root}/assets?per_page=100", "--paginate", "--slurp")
    assets = [asset for page in pages for asset in page]
    fields = ("id", "node_id", "tag_name", "target_commitish", "name", "body", "created_at",
              "draft", "prerelease", "published_at")
    state = {field: release[field] for field in fields}
    state["immutable"] = release.get("immutable", False)
    if state["id"] != release_id or state["tag_name"] != bound["tag"]:
        raise ValueError("release ID or tag changed")
    if state["target_commitish"] != bound["commit"]:
        raise ValueError("release target differs from verified source")
    state["assets"] = sorted((asset_state(asset) for asset in assets), key=lambda a: a["name"])
    if len({a["id"] for a in state["assets"]}) != len(assets):
        raise ValueError("duplicate asset ID")
    return state


def asset_state(asset):
    positive_id(asset["id"])
    if asset["state"] != "uploaded":
        raise ValueError("asset upload incomplete")
    return {key: asset[key] for key in
            ("id", "name", "size", "state", "created_at", "updated_at", "digest")}


def verify_bytes(bound, state, hashes):
    if [a["name"] for a in state["assets"]] != sorted(hashes):
        raise ValueError("release asset set changed")
    for asset in state["assets"]:
        contents = gh_api(f"repos/{bound['repository']}/releases/assets/{asset['id']}",
                          "-H", "Accept: application/octet-stream", binary=True)
        digest = sha256_bytes(contents)
        if digest != hashes[asset["name"]] or len(contents) != asset["size"]:
            raise ValueError("release asset bytes changed")
        if asset["digest"] not in (None, f"sha256:{digest}"):
            raise ValueError("release asset digest mismatch")


def require_draft(state):
    if (state["draft"] is not True or state["published_at"] is not None
            or state["prerelease"] is not False):
        raise ValueError("release is not an unpublished draft; rerun refused")


def seal_draft(bound, directory, trusted, seal_path):
    verify_release(directory, bound["tag"], bound["commit"], directory / "SHA256SUMS", trusted)
    # These local bytes passed the workflow's attestations and native-record checks.
    # Equality by asset ID binds downloads to that evidence, including SBOM/checksums.
    hashes = {p.name: sha256_bytes(p.read_bytes()) for p in directory.iterdir() if p.is_file()}
    pages = gh_api(f"repos/{bound['repository']}/releases?per_page=100", "--paginate", "--slurp")
    matches = [r for page in pages for r in page if r["tag_name"] == bound["tag"]]
    if len(matches) != 1:
        raise ValueError("expected exactly one release for tag")
    state = release_state(bound, matches[0]["id"])
    require_draft(state)
    remote_tag(bound)
    verify_bytes(bound, state, hashes)
    if release_state(bound, state["id"]) != state:
        raise ValueError("draft changed during verification")
    remote_tag(bound)
    with seal_path.open("x", encoding="utf-8") as stream:
        json.dump(dict(identity=bound, release=state, hashes=hashes), stream, sort_keys=True)


def require_published(state, sealed):
    expected = dict(sealed, draft=False, immutable=True, published_at=state["published_at"])
    if (state["draft"] is not False or state["immutable"] is not True
            or not state["published_at"] or state != expected):
        raise ValueError("published release differs from sealed draft or is not immutable")


def immutable_disabled_message(repository, detail=""):
    base = (
        f"immutable releases are disabled for {repository}; "
        "enable immutable releases in repository settings (owner action) "
        "before publishing; refusing to publish mutable release"
    )
    return f"{base} ({detail})" if detail else base


def _immutable_api_detail(error):
    parts = []
    for attr in ("stderr", "output"):
        value = getattr(error, attr, None)
        if not value:
            continue
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        text = str(value).strip()
        if text:
            parts.append(f"{attr}: {text}")
    combined = " ".join(parts)
    match = re.search(r"HTTP\s+(\d{3})", combined, re.IGNORECASE)
    if match is None:
        match = re.search(r"\b(401|403|404)\b", combined)
    status = f"HTTP {match.group(1)}" if match else f"exit {error.returncode}"
    if parts:
        return f"{status}; {'; '.join(parts)}"
    return status


def _is_immutable_permissions_error(error):
    texts = []
    for attr in ("stderr", "output"):
        value = getattr(error, attr, None)
        if not value:
            continue
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        texts.append(str(value).lower())
    combined = " ".join(texts)
    if "http 403" in combined or "http 401" in combined:
        return True
    for marker in ("forbidden", "resource not accessible", "must have admin",
                   "requires admin", "permission denied", "not authorized"):
        if marker in combined:
            return True
    return bool(re.search(r"\b403\b", combined))


def require_immutable_releases(bound):
    endpoint = f"repos/{bound['repository']}/immutable-releases"
    try:
        setting = gh_api(endpoint)
    except subprocess.CalledProcessError as error:
        detail = _immutable_api_detail(error)
        if _is_immutable_permissions_error(error):
            print(f"warning: cannot verify immutable releases setting for "
                  f"{bound['repository']} ({detail}); skipping precheck; "
                  f"post-publish immutable:true check will enforce",
                  file=sys.stderr)
            return
        raise ValueError(
            immutable_disabled_message(bound["repository"], detail)) from error
    if not isinstance(setting, dict) or setting.get("enabled") is not True:
        raise ValueError(
            immutable_disabled_message(bound["repository"], f"enabled: {setting!r}"))


def publish(bound, seal_path):
    seal = json.loads(seal_path.read_text(encoding="utf-8"))
    if seal["identity"] != bound:
        raise ValueError("seal source or workflow run/attempt differs; rerun refused")
    sealed = seal["release"]
    release_id = positive_id(sealed["id"])
    require_immutable_releases(bound)
    current = release_state(bound, release_id)
    require_draft(current)
    if current != sealed:
        raise ValueError("draft changed after verification")
    verify_bytes(bound, current, seal["hashes"])
    if release_state(bound, release_id) != sealed:
        raise ValueError("draft changed before PATCH")
    remote_tag(bound)
    try:
        response = gh_api(f"repos/{bound['repository']}/releases/{release_id}",
                          "--method", "PATCH", "-F", "draft=false")
        remote_tag(bound)
        response_state = {key: response[key] for key in sealed if key != "assets"}
        response_state["assets"] = sorted(
            (asset_state(a) for a in response["assets"]), key=lambda a: a["name"])
        require_published(response_state, sealed)
        final = release_state(bound, release_id)
        require_published(final, sealed)
        if final != response_state:
            raise ValueError("release changed after PATCH")
        verify_bytes(bound, final, seal["hashes"])
        remote_tag(bound)
        if release_state(bound, release_id) != final:
            raise ValueError("release changed during published verification")
    except Exception as error:
        raise RuntimeError("PATCH attempted; release may be public. Incident response required") from error
    print(f"Verified published release ID {release_id} at source {bound['commit']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("verify", "publish"))
    parser.add_argument("--seal", required=True, type=Path)
    parser.add_argument("--directory", type=Path, default=Path("dist"))
    parser.add_argument("--trusted", type=Path, default=Path("trusted-native-records"))
    args = parser.parse_args()
    bound = identity()
    if args.command == "verify":
        seal_draft(bound, args.directory, args.trusted, args.seal)
    else:
        publish(bound, args.seal)


if __name__ == "__main__":
    main()
