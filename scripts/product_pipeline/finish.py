"""Verify assembled outputs, exercise local compute coordination and report total time."""

from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import zipfile

from .records import Timings, digest, now, write
from .sources import api, read


def require_checks(document, deadline=5400):
    pending = dict(document["repositories"])
    results = {}
    started = time.monotonic()
    while pending:
        for name, entry in list(pending.items()):
            resource = f"repos/{entry['repository']}/commits/{entry['revision']}/check-runs?per_page=100&filter=latest"
            rows = [row for row in api(resource)["check_runs"] if row["name"] == "CI required"
                    and row.get("app", {}).get("slug") == "github-actions"]
            if not rows:
                continue
            latest = max(rows, key=lambda row: row["id"])
            if latest["status"] != "completed":
                continue
            if latest["conclusion"] != "success":
                raise ValueError(f"{name} required CI failed at {entry['revision']}: {latest['html_url']}")
            results[name] = {"revision": entry["revision"], "url": latest["html_url"], "result": "success"}
            pending.pop(name)
            print(f"Required CI passed: {name}@{entry['revision']}", flush=True)
        if pending:
            if time.monotonic() - started > deadline:
                raise TimeoutError(f"required CI did not finish: {', '.join(pending)}")
            print(f"Waiting for required CI: {', '.join(pending)}", flush=True)
            time.sleep(20)
    return results


def unpack_vsix(archive, destination):
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            if not (destination / member.filename).resolve().is_relative_to(destination.resolve()):
                raise ValueError("VSIX member escapes its installation directory")
        bundle.extractall(destination)
    for binary in (destination / "extension/bin").rglob("*"):
        if binary.is_file():
            binary.chmod(0o755)
    return destination / "extension"


def verify_native(document, output, installed, staging):
    found = set()
    for archive in sorted((output / "native").glob("*.tar.gz")):
        destination = staging / archive.name.removesuffix(".tar.gz")
        destination.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(destination, filter="data")
        identity = json.loads((destination / "bundle.json").read_text())
        name = identity["repository"].removeprefix("idleai/")
        if name not in ["editchain", "host-tools"] or name in found:
            raise ValueError("unexpected or duplicate native product bundle")
        found.add(name)
        if identity["commit"] != document["repositories"][name]["revision"]:
            raise ValueError(f"native bundle contains a different source revision: {name}")
        if json.loads((destination / "product-inputs.json").read_text()) != document:
            raise ValueError(f"native bundle contains a different product selection: {name}")
        for filename, checksum in identity["files"].items():
            path = destination / filename
            if not path.resolve().is_relative_to(destination.resolve()) or digest(path) != checksum:
                raise ValueError(f"native bundle file changed: {name}/{filename}")
        if name == "host-tools":
            if digest(installed / "bin/linux-x64/idle-host") != digest(destination / "bin/idle-host"):
                raise ValueError("the VSIX does not contain the tested native host")
    if found != {"editchain", "host-tools"}:
        raise ValueError("both native producer bundles are required")
    if json.loads((installed / "dist/product-inputs.json").read_text()) != document:
        raise ValueError("the VSIX does not contain this build's source selection")


def finish(plan, sources, output):
    document = read(plan)
    timings = Timings(output / "integration-timings.json")
    cargo = json.loads((output / "cargo-result.json").read_text())
    codex = json.loads((output / "codex-result.json").read_text())
    if cargo["product_id"] != document["id"] or cargo["vsix_sha256"] != digest(output / "idle.vsix"):
        raise ValueError("the Cargo product outputs do not match the selected build")
    if codex["revision"] != document["repositories"]["codex-evo"]["revision"]:
        raise ValueError("the Codex package does not match the selected source")
    for filename, checksum in codex["archives"].items():
        if digest(output / filename) != checksum:
            raise ValueError(f"Codex archive changed: {filename}")
    with tempfile.TemporaryDirectory(prefix="idle-product-check-") as temporary:
        staging = Path(temporary)
        with timings.step("verify packaged component identities"):
            installed = unpack_vsix(output / "idle.vsix", staging / "vsix")
            verify_native(document, output, installed, staging)
            runtime = staging / "runtime"
            runtime.mkdir()
            with tarfile.open(output / "codex-package-x86_64-unknown-linux-gnu.tar.gz") as bundle:
                bundle.extractall(runtime, filter="data")
        with timings.step("packaged extension and Codex local compute integration"):
            environment = dict(os.environ, IDLE_PACKAGED_EXTENSION=str(installed),
                               IDLE_CODEX_PACKAGE=str(runtime), IDLE_EXTENSION_SOURCE=str(sources / "vscode-extension"))
            script = Path(__file__).parents[1] / "smoke-product.cjs"
            subprocess.run(["node", str(script)], env=environment, check=True)
    with timings.step("require component CI for the exact selected commits"):
        checks = require_checks(document)
    completed = now()
    start = document.get("run", {}).get("created_at", document["created_at"])
    elapsed = (datetime.fromisoformat(completed) - datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds()
    result = {"schema": 1, "product_id": document["id"], "result": "success", "started_at": start,
              "ready_at": completed, "elapsed_seconds": round(elapsed, 3), "checks": checks,
              "run": document.get("run"), "trigger": document["trigger"],
              "artifacts": {str(path.relative_to(output)): digest(path) for path in sorted(output.rglob("*"))
                            if path.is_file() and path.suffix in [".gz", ".vsix"]}}
    write(output / "product-result.json", result)
    with open(output / "SHA256SUMS", "w") as sums:
        for filename, checksum in result["artifacts"].items():
            sums.write(f"{checksum}  {filename}\n")
    archive = output / "idle-product-linux-x64.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        for path in sorted(output.iterdir()):
            if path != archive:
                bundle.add(path, arcname=path.name)
    archive.with_suffix(archive.suffix + ".sha256").write_text(f"{digest(archive)}  {archive.name}\n")
    summary = f"Product {document['id']} passed in {elapsed / 60:.1f} minutes from workflow creation.\n"
    print(summary, flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(summary + "\nThe downloadable bundle contains the tested VSIX, Codex packages, native bundles, source revisions and timings.\n")
