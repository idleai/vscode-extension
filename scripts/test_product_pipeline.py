"""Product builds must use the requested source set and reject stale internal packages."""

import json
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from product_pipeline import sources
from product_pipeline.build import local_packages, pinned_artifacts
from product_pipeline.finish import require_checks, unpack_vsix
from product_pipeline.records import Timings
from product_pipeline.publish import validate


class ProductTests(unittest.TestCase):
    def test_workflow_source_does_not_fix_project_checkout_commits(self):
        root = Path(__file__).resolve().parents[1]
        for path in (root / ".github/workflows").glob("product*.yml"):
            source = path.read_text()
            self.assertIsNone(re.search(r"ref:\s*['\"]?[0-9a-f]{40}\b", source))
            self.assertIsNone(re.search(r"uses:\s*idleai/\S+@[0-9a-f]{40}\b", source))

    def test_component_refs_are_resolved_per_run_and_trigger_revision_is_preserved(self):
        commits = {name: format(index, "040x") for index, name in enumerate(sources.REPOSITORIES, 1)}
        trigger = "f" * 40
        requests = []

        def api(resource):
            requests.append(resource)
            name, ref = resource.split("/")[2], resource.rsplit("/", 1)[1]
            return {"sha": trigger if ref == trigger else commits[name],
                    "commit": {"committer": {"date": "2026-01-01T00:00:00Z"}}}

        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {}, clear=True), \
                patch.object(sources, "api", side_effect=api), \
                patch.object(sources.subprocess, "check_output", return_value="e" * 40 + "\n"):
            document = sources.plan(Path(temporary) / "plan.json", source_repository="idleai/editchain", source_revision=trigger)
        self.assertEqual(document["repositories"]["editchain"]["revision"], trigger)
        self.assertIn("repos/idleai/codex-evo/commits/idle-base", requests)
        self.assertIn("repos/idleai/host-tools/commits/main", requests)
        self.assertEqual(len(requests), len(sources.REPOSITORIES))
        self.assertEqual(document["coordinator_revision"], "e" * 40)

    def test_overrides_cannot_select_unknown_repositories_or_replace_the_trigger(self):
        for value in ['[]', '{"unknown":"main"}', '{"editchain":"main"}', '{"editchain":"--upload-pack=x"}']:
            with self.assertRaises(ValueError):
                sources.overrides(value)
        with self.assertRaisesRegex(ValueError, "triggering commit"):
            sources.plan(Path("unused"), json.dumps({"editchain": "a" * 40}), "idleai/editchain", "b" * 40)

    def test_checkout_rejects_a_directory_with_unrelated_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "user-file").write_text("keep")
            with self.assertRaisesRegex(ValueError, "not owned"):
                sources.checkout({}, root, [])
            self.assertEqual((root / "user-file").read_text(), "keep")

    def test_published_internal_fallback_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "editchain"
            selected = {"name": "editchain-core", "version": "0.1.7", "source": None,
                        "manifest_path": str(root / "crates/core/Cargo.toml")}
            self.assertEqual(local_packages({"packages": [selected]}, [root])[0]["repository"], "editchain")
            stale = dict(selected, source="registry+sparse+https://raw.githubusercontent.com/idleai/editchain/cargo-index/",
                         manifest_path=str(Path(temporary) / "registry/editchain/Cargo.toml"))
            with self.assertRaisesRegex(ValueError, "published internal package"):
                local_packages({"packages": [stale]}, [root])

    def test_native_selection_uses_candidate_bytes_and_rejects_incompatible_versions(self):
        dependency = {"repository": "idleai/host-tools", "package": "idle-coordination", "version": "^0.5.0"}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".github").mkdir()
            (root / ".github/released-dependencies.lock.json").write_text(json.dumps({"artifacts": {}}))
            (root / "native-dependencies.json").write_text(json.dumps({"schema": 2, "dependencies": {"host-tools": dependency}}))
            resolver = SimpleNamespace(MANIFESTS=("native-dependencies.json",),
                                       matches=lambda requirement, version: version[:2] == (0, 5))
            candidate = {"tag": "idle-coordination-v0.5.1", "sha256": {"linux-x64": "b" * 64}, "local_platform": "linux-x64"}
            local = {("idleai/host-tools", "idle-coordination"): candidate}
            result = pinned_artifacts(root, resolver, local)
            self.assertEqual(result["native-dependencies.json"]["dependencies"]["host-tools"]["sha256"], candidate["sha256"])
            candidate["tag"] = "idle-coordination-v0.4.9"
            with self.assertRaisesRegex(ValueError, "does not satisfy"):
                pinned_artifacts(root, resolver, local)

    def test_required_ci_does_not_accept_an_older_successful_attempt(self):
        document = {"repositories": {"host-tools": {"repository": "idleai/host-tools", "revision": "c" * 40}}}
        row = {"name": "CI required", "app": {"slug": "github-actions"}, "status": "completed", "html_url": "https://example.test/check"}
        rows = [dict(row, id=1, conclusion="success"), dict(row, id=2, conclusion="failure")]
        with patch("product_pipeline.finish.api", return_value={"check_runs": rows}):
            with self.assertRaisesRegex(ValueError, "required CI failed"):
                require_checks(document)

    def test_failed_stage_retains_duration_and_failure_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "timings.json"
            with self.assertRaises(RuntimeError):
                with Timings(path).step("failing build"):
                    raise RuntimeError("compiler failed")
            row = json.loads(path.read_text())["steps"][0]
            self.assertEqual(row["result"], "failed")
            self.assertGreaterEqual(row["seconds"], 0)

    def test_vsix_cannot_write_outside_the_installation_directory(self):
        import zipfile
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with zipfile.ZipFile(root / "bad.vsix", "w") as archive:
                archive.writestr("../outside", "not an extension")
            with self.assertRaisesRegex(ValueError, "escapes"):
                unpack_vsix(root / "bad.vsix", root / "installed")
            self.assertFalse((root / "outside").exists())

    def test_publication_accepts_only_the_verified_bytes_and_trigger(self):
        import hashlib
        import tarfile
        revision = "d" * 40
        trigger = {"repository": "idleai/editchain", "revision": revision}
        run = {"id": 42, "url": "https://example.test/run/42"}
        document = {"schema": 1, "id": "product-test", "trigger": trigger, "run": run,
                    "repositories": {name: {"repository": f"idleai/{name}", "revision": revision}
                                     for name in sources.REPOSITORIES}}
        result = {"result": "success", "product_id": document["id"], "trigger": trigger, "run": run,
                  "checks": {name: {"result": "success", "revision": revision} for name in sources.REPOSITORIES},
                  "artifacts": {"idle.vsix": hashlib.sha256(b"accepted extension").hexdigest()}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "idle.vsix").write_bytes(b"accepted extension")
            (root / "product-inputs.json").write_text(json.dumps(document))
            (root / "product-result.json").write_text(json.dumps(result))
            archive = root / "idle-product-linux-x64.tar.gz"
            with tarfile.open(archive, "w:gz") as bundle:
                for name in ["idle.vsix", "product-inputs.json", "product-result.json"]:
                    bundle.add(root / name, arcname=name)
            checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
            (root / (archive.name + ".sha256")).write_text(f"{checksum}  {archive.name}\n")
            self.assertEqual(validate(root, trigger["repository"], revision, 42), (document, result))
            with self.assertRaisesRegex(ValueError, "different triggering commit"):
                validate(root, trigger["repository"], "a" * 40, 42)
            with self.assertRaisesRegex(ValueError, "different workflow run"):
                validate(root, trigger["repository"], revision, 43)
            (root / "idle.vsix").write_bytes(b"changed extension")
            with self.assertRaisesRegex(ValueError, "VSIX changed"):
                validate(root, trigger["repository"], revision, 42)


if __name__ == "__main__":
    unittest.main()
