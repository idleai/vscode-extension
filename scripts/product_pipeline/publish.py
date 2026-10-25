"""Publish the accepted product files without rebuilding or replacing assets."""

import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from urllib.error import HTTPError

from .records import digest
from .sources import api, read


ASSETS = ["idle-product-linux-x64.tar.gz", "idle-product-linux-x64.tar.gz.sha256",
          "idle.vsix", "product-inputs.json", "product-result.json"]


def validate(output, repository, revision, run_id):
    document = read(output / "product-inputs.json")
    result = json.loads((output / "product-result.json").read_text())
    trigger = {"repository": repository, "revision": revision}
    if document["trigger"] != trigger or result["trigger"] != trigger:
        raise ValueError("the product belongs to a different triggering commit")
    if result["result"] != "success" or result["product_id"] != document["id"]:
        raise ValueError("the product has not passed acceptance")
    if str(result["run"]["id"]) != str(run_id) or result["run"] != document["run"]:
        raise ValueError("the product belongs to a different workflow run")
    if set(result["checks"]) != set(document["repositories"]):
        raise ValueError("the product is missing component checks")
    for name, source in document["repositories"].items():
        check = result["checks"][name]
        if check["result"] != "success" or check["revision"] != source["revision"]:
            raise ValueError(f"the selected component has not passed CI: {name}")
    if digest(output / "idle.vsix") != result["artifacts"]["idle.vsix"]:
        raise ValueError("the accepted VSIX changed before publication")
    archive = output / ASSETS[0]
    if (output / ASSETS[1]).read_text().strip() != f"{digest(archive)}  {archive.name}":
        raise ValueError("the accepted product archive changed before publication")
    with tarfile.open(archive) as bundle:
        for name, expected in [("product-inputs.json", document), ("product-result.json", result)]:
            if json.load(bundle.extractfile(name)) != expected:
                raise ValueError(f"the product archive has a different {name}")
    return document, result


def publish(output):
    repository, revision = os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_SHA"]
    run_id = os.environ["GITHUB_RUN_ID"]
    document, result = validate(output, repository, revision, run_id)
    tag = f"product-linux-{document['id']}-{run_id}-{os.environ['GITHUB_RUN_ATTEMPT']}"

    def gh(*arguments):
        return subprocess.check_output(["gh", *arguments, "--repo", repository], text=True).strip()

    try:
        release = api(f"repos/{repository}/releases/tags/{tag}")
    except HTTPError as error:
        if error.code != 404:
            raise
        release = None
    with tempfile.TemporaryDirectory(prefix="idle-product-publish-") as temporary:
        staging = Path(temporary)
        if release is None:
            notes = staging / "notes.txt"
            notes.write_text(f"Validated Linux desktop product from {repository}@{revision}.\n\n"
                             f"Acceptance completed {result['elapsed_seconds'] / 60:.1f} minutes after workflow creation. "
                             "The workflow duration also includes packaging, upload and publication.\n\n"
                             f"Build and checks: {result['run']['url']}\n\n"
                             "Install idle.vsix in VS Code. The complete archive contains the tested native and Codex packages, "
                             "source selections, checksums and stage timings.\n")
            gh("release", "create", tag, "--target", revision, "--draft", "--prerelease", "--latest=false",
               "--title", f"Linux product {document['id']}", "--notes-file", str(notes))
            release = api(f"repos/{repository}/releases/tags/{tag}")
        if release["target_commitish"] != revision or not release["prerelease"]:
            raise ValueError("the existing release does not match this product candidate")
        assets = {asset["name"]: asset for asset in release["assets"]}
        if set(assets) - set(ASSETS):
            raise ValueError("the existing product release has unexpected assets")
        for name in ASSETS:
            path = output / name
            if name in assets:
                gh("release", "download", tag, "--pattern", name, "--dir", str(staging))
                if digest(staging / name) != digest(path):
                    raise ValueError(f"refusing to replace an existing product asset: {name}")
            elif release["draft"]:
                gh("release", "upload", tag, str(path))
            else:
                raise ValueError(f"the published product is missing an asset: {name}")
        if release["draft"]:
            gh("release", "edit", tag, "--draft=false", "--prerelease", "--latest=false")
        url = gh("release", "view", tag, "--json", "url", "--jq", ".url")
    print(f"Published tested product: {url}", flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(f"[Download the tested Linux product]({url})\n")
