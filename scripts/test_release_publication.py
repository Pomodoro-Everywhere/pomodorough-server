#!/usr/bin/env python3
"""Fake GitHub adversarial coverage for F10, without network or real releases."""
import copy
import ast
import inspect
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import release_identity
import release_publication as publication
from test_release_identity_s7 import COMMIT, TAG, ReleaseFixture


class FakeGitHub:
    def __init__(self, directory):
        self.root = "repos/owner/repo/releases"
        self.tag_sha = COMMIT
        self.calls = []
        self.hook = lambda endpoint, arguments: None
        self.contents = {}
        assets = []
        for number, path in enumerate(sorted(directory.iterdir()), 100):
            contents = path.read_bytes()
            self.contents[number] = contents
            assets.append(dict(id=number, name=path.name, size=len(contents), state="uploaded",
                               created_at="created", updated_at="updated", digest=None))
        self.release = dict(id=42, node_id="release-42", tag_name=TAG, target_commitish=COMMIT,
                            name=TAG, body="notes", created_at="created", draft=True,
                            prerelease=False, published_at=None, immutable=False, assets=assets)

    def api(self, endpoint, *arguments, binary=False):
        self.calls.append((endpoint, arguments))
        self.hook(endpoint, arguments)
        if "/git/ref/tags/" in endpoint:
            return {"object": {"type": "commit", "sha": self.tag_sha}}
        if endpoint == self.root + "?per_page=100":
            return [[copy.deepcopy(self.release)]]
        if endpoint == self.root + "/42/assets?per_page=100":
            return [copy.deepcopy(self.release["assets"])]
        if endpoint.startswith(self.root + "/assets/"):
            assert binary
            return self.contents[int(endpoint.rsplit("/", 1)[1])]
        if endpoint != self.root + "/42":
            raise AssertionError(f"unexpected API endpoint: {endpoint}")
        if self.release["id"] != 42:
            raise ValueError("release ID missing")
        if "PATCH" in arguments:
            self.release.update(draft=False, immutable=True, published_at="published")
        return copy.deepcopy(self.release)

    def patches(self):
        return [endpoint for endpoint, arguments in self.calls if "PATCH" in arguments]


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.directory = root / "dist"
        self.directory.mkdir()
        ReleaseFixture(release_identity, self.directory).complete_release()
        self.seal = root / "seal.json"
        self.bound = dict(repository="owner/repo", tag=TAG, commit=COMMIT,
                          workflow_sha=COMMIT, run="123", attempt="1")
        self.github = FakeGitHub(self.directory)
        patch = mock.patch.object(publication, "gh_api", side_effect=self.github.api)
        patch.start()
        self.addCleanup(patch.stop)

    def verify(self):
        publication.seal_draft(self.bound, self.directory, self.directory, self.seal)

    def publish(self):
        publication.publish(self.bound, self.seal)

    def test_success_binds_all_assets_and_patches_only_verified_id(self):
        self.verify()
        sealed = json.loads(self.seal.read_text())
        self.assertEqual(sealed["release"]["id"], 42)
        self.assertEqual(len(sealed["hashes"]), 17)
        self.publish()
        self.assertEqual(self.github.patches(), [self.github.root + "/42"])
        self.assertTrue(self.github.release["immutable"])

    def test_replacement_draft_same_tag_rejected_before_patch(self):
        self.verify()
        self.github.release["id"] = 43
        with self.assertRaisesRegex(ValueError, "ID missing"):
            self.publish()
        self.assertEqual(self.github.patches(), [])

    def test_replaced_asset_id_same_name_and_bytes_rejected(self):
        self.verify()
        self.github.release["assets"][0]["id"] = 999
        with self.assertRaisesRegex(ValueError, "draft changed"):
            self.publish()
        self.assertEqual(self.github.patches(), [])

    def test_same_id_changed_asset_bytes_rejected(self):
        self.verify()
        self.github.contents[100] = b"forged"
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            self.publish()
        self.assertEqual(self.github.patches(), [])

    def test_asset_added_removed_renamed_or_metadata_changed(self):
        self.verify()
        original = copy.deepcopy(self.github.release)
        for field, value in (("name", "renamed"), ("size", 0), ("updated_at", "later")):
            self.github.release = copy.deepcopy(original)
            self.github.release["assets"][0][field] = value
            with self.assertRaises(ValueError, msg=field):
                self.publish()
        for assets in (original["assets"][:-1], original["assets"] + [original["assets"][0]]):
            self.github.release = dict(original, assets=assets)
            with self.assertRaises(ValueError):
                self.publish()
        self.assertEqual(self.github.patches(), [])

    def test_moved_tag_rejected_before_patch(self):
        self.verify()
        self.github.tag_sha = "f" * 40
        with self.assertRaisesRegex(ValueError, "remote tag"):
            self.publish()
        self.assertEqual(self.github.patches(), [])

    def test_rerun_attempt_or_source_cannot_reuse_seal(self):
        self.verify()
        for field in ("attempt", "run", "commit", "workflow_sha", "repository", "tag"):
            with self.assertRaisesRegex(ValueError, "seal source", msg=field):
                publication.publish(dict(self.bound, **{field: "changed"}), self.seal)
        self.assertEqual(self.github.patches(), [])

    def test_existing_seal_and_already_public_release_refused(self):
        self.verify()
        with self.assertRaises(FileExistsError):
            self.verify()
        self.publish()
        with self.assertRaisesRegex(ValueError, "rerun refused"):
            self.publish()
        self.assertEqual(len(self.github.patches()), 1)

    def test_draft_metadata_and_source_changes_refused(self):
        self.verify()
        original = copy.deepcopy(self.github.release)
        for field in ("target_commitish", "tag_name", "body", "node_id", "name", "created_at"):
            self.github.release = dict(original, **{field: "changed"})
            with self.assertRaises(ValueError, msg=field):
                self.publish()
        self.assertEqual(self.github.patches(), [])

    def test_mutation_during_prepatch_download_is_rechecked(self):
        self.verify()
        def mutate(endpoint, arguments):
            if "/releases/assets/" in endpoint:
                self.github.release["body"] = "changed during download"
        self.github.hook = mutate
        with self.assertRaisesRegex(ValueError, "before PATCH"):
            self.publish()
        self.assertEqual(self.github.patches(), [])

    def test_tag_race_at_patch_reports_public_incident(self):
        self.verify()
        def mutate(endpoint, arguments):
            if "PATCH" in arguments:
                self.github.tag_sha = "f" * 40
        self.github.hook = mutate
        with self.assertRaisesRegex(RuntimeError, "may be public"):
            self.publish()
        self.assertFalse(self.github.release["draft"])
        self.assertEqual(len(self.github.patches()), 1)

    def test_asset_race_at_patch_reports_public_incident(self):
        self.verify()
        def mutate(endpoint, arguments):
            if "PATCH" in arguments:
                self.github.contents[100] = b"forged after checks"
        self.github.hook = mutate
        with self.assertRaisesRegex(RuntimeError, "Incident response"):
            self.publish()
        self.assertEqual(len(self.github.patches()), 1)

    def test_patch_response_and_final_state_both_verified(self):
        self.verify()
        original = self.github.api
        for corrupt_response in (True, False):
            self.github.release.update(draft=True, immutable=False, published_at=None)
            def corrupt(endpoint, *arguments, binary=False):
                response = original(endpoint, *arguments, binary=binary)
                if endpoint.endswith("/42") and ("PATCH" in arguments) == corrupt_response:
                    if response["draft"] is False:
                        response["immutable"] = False
                return response
            with mock.patch.object(publication, "gh_api", side_effect=corrupt):
                with self.assertRaisesRegex(RuntimeError, "Incident response"):
                    self.publish()

    def test_unverified_remote_bytes_never_sealed(self):
        self.github.contents[100] = b"replacement before seal"
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            self.verify()
        self.assertFalse(self.seal.exists())

    def test_annotated_tag_peels_to_expected_commit(self):
        original = self.github.api
        def annotated(endpoint, *arguments, **kwargs):
            if "/git/ref/" in endpoint:
                return {"object": {"type": "tag", "sha": "a" * 40}}
            if "/git/tags/" in endpoint:
                return {"object": {"type": "commit", "sha": COMMIT}}
            return original(endpoint, *arguments, **kwargs)
        with mock.patch.object(publication, "gh_api", side_effect=annotated):
            self.verify()
            self.publish()


class WorkflowTests(unittest.TestCase):
    def test_workflow_uses_seal_not_tag_publication(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/release.yml").read_text()
        self.assertNotIn("gh release edit", workflow)
        self.assertNotIn("gh release download", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn('--target "$GITHUB_SHA"', workflow)
        self.assertIn("python3 -m unittest discover -s scripts -p 'test_release*.py' -v", workflow)
        self.assertIn("printf '%s\\0' dist/*.tar.gz dist/*.identity.json | xargs -0 -P 4 -I{} gh attestation verify {}", workflow)
        self.assertNotIn("printf '%s\\0' dist/* | xargs -0 -P 4 -I{} gh attestation verify {}", workflow)
        self.assertEqual(workflow.count('--seal "$RUNNER_TEMP/server-release-seal.json"'), 2)
        self.assertLess(workflow.index("release_publication.py verify"),
                        workflow.index("release_publication.py publish"))
        self.assertIn("  verify-fast:\n", workflow)
        self.assertIn("  verify-race:\n", workflow)
        self.assertNotRegex(workflow, r"^  verify:\n")
        self.assertIn("needs: [preflight, verify-fast, verify-core, verify-web]", workflow)
        self.assertIn("needs: [build, verify-fast, verify-race]", workflow)
        self.assertIn("needs: [package, verify-fast, verify-race]", workflow)
        self.assertIn("release-gobuild-", workflow)
        self.assertIn("~/.cache/go-build", workflow)
        self.assertIn("Validate draft seal inputs", workflow)
        self.assertLess(workflow.index("  preflight:"), workflow.index("  build:"))

    def test_publication_functions_remain_within_size_limit(self):
        source = inspect.getsource(publication)
        functions = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.FunctionDef)]
        self.assertTrue(functions)
        for function in functions:
            self.assertLessEqual(function.end_lineno - function.lineno + 1, 50, function.name)

    def test_gh_adapter_uses_exact_id_patch_and_raw_asset_download(self):
        with mock.patch.object(publication.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, stdout=b'{}')
            publication.gh_api("repos/owner/repo/releases/42", "--method", "PATCH", "-F", "draft=false")
            self.assertEqual(run.call_args.args[0], ["gh", "api", "repos/owner/repo/releases/42",
                                                     "--method", "PATCH", "-F", "draft=false"])
            run.return_value.stdout = b"\x00binary\xff"
            self.assertEqual(publication.gh_api("assets/100", binary=True), b"\x00binary\xff")


if __name__ == "__main__":
    unittest.main()
