"""Resolve immutable source revisions and prepare dedicated build checkouts."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote
from urllib.request import Request, urlopen

from .records import now, write


REPOSITORIES = {
    "editchain": "main", "host-tools": "main", "app-core": "main",
    "web-ui": "main", "vscode-extension": "main", "codex-evo": "idle-base",
}
SHA = re.compile(r"[0-9a-f]{40}")


def api(resource):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "idle-product-build"}
    if os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    request = Request("https://api.github.com/" + resource, headers=headers)
    with urlopen(request, timeout=60) as response:
        return json.load(response)


def overrides(value):
    selected = json.loads(value)
    if not isinstance(selected, dict) or set(selected) - REPOSITORIES.keys():
        raise ValueError("revision overrides must name known product repositories")
    if any(not isinstance(sha, str) or not SHA.fullmatch(sha) for sha in selected.values()):
        raise ValueError("every revision override must be a full commit SHA")
    return selected


def plan(path, revisions="{}", source_repository="", source_revision=""):
    selected = overrides(revisions)
    if source_repository or source_revision:
        name = source_repository.removeprefix("idleai/")
        if source_repository != f"idleai/{name}" or name not in REPOSITORIES:
            raise ValueError("unknown source repository")
        if not SHA.fullmatch(source_revision):
            raise ValueError("the triggering revision must be a full commit SHA")
        if name in selected and selected[name] != source_revision:
            raise ValueError("an override cannot replace the triggering commit")
        selected[name] = source_revision
    tools_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=Path(__file__).parents[2], text=True).strip()
    document = {"schema": 1, "created_at": now(), "coordinator_revision": tools_revision, "repositories": {},
                "trigger": {"repository": source_repository, "revision": source_revision}}
    for name, branch in REPOSITORIES.items():
        ref = selected.get(name, branch)
        commit = api(f"repos/idleai/{name}/commits/{quote(ref, safe='')}")
        revision = commit["sha"]
        if not SHA.fullmatch(revision) or name in selected and revision != selected[name]:
            raise ValueError(f"GitHub returned a different revision for {name}")
        document["repositories"][name] = {"repository": f"idleai/{name}", "revision": revision,
                                           "branch": branch, "committed_at": commit["commit"]["committer"]["date"]}
    identity = {name: entry["revision"] for name, entry in document["repositories"].items()}
    build_identity = {"components": identity, "coordinator": tools_revision}
    document["id"] = hashlib.sha256(json.dumps(build_identity, sort_keys=True).encode()).hexdigest()[:20]
    if os.environ.get("GITHUB_RUN_ID"):
        run = api(f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}")
        document["run"] = {"id": run["id"], "url": run["html_url"], "created_at": run["created_at"]}
    write(path, document)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"id={document['id']}\ncodex={identity['codex-evo']}\ncoordinator={tools_revision}\n")
    return document


def read(path):
    document = json.loads(Path(path).read_text())
    if document.get("schema") != 1 or set(document.get("repositories", {})) != REPOSITORIES.keys():
        raise ValueError("invalid product source selection")
    for name, entry in document["repositories"].items():
        if entry.get("repository") != f"idleai/{name}" or not SHA.fullmatch(entry.get("revision", "")):
            raise ValueError(f"invalid source selection for {name}")
    return document


def checkout(document, directory, names):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / ".idle-product-checkouts"
    if any(directory.iterdir()) and not marker.is_file():
        raise ValueError("refusing to reuse a directory not owned by the product builder")
    marker.touch()
    for name in names:
        entry = document["repositories"][name]
        root = directory / name
        if root.is_symlink():
            raise ValueError(f"checkout must not be a symbolic link: {name}")
        root.mkdir(exist_ok=True)
        def git(*args):
            return subprocess.run(["git", "-c", "credential.helper=", "-c", "credential.interactive=false",
                                   "-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=30", *args],
                                  cwd=root, check=True, text=True, capture_output=True).stdout.strip()
        if not (root / ".git").is_dir():
            git("init")
            git("remote", "add", "origin", f"https://github.com/{entry['repository']}.git")
        if git("remote", "get-url", "origin") != f"https://github.com/{entry['repository']}.git":
            raise ValueError(f"unexpected checkout origin for {name}")
        git("fetch", "--depth=1", "--no-tags", "origin", entry["revision"])
        git("checkout", "--detach", "--force", entry["revision"])
        git("clean", "-ffd", "-e", "target")
        if git("rev-parse", "HEAD") != entry["revision"]:
            raise ValueError(f"checkout revision changed for {name}")
        print(f"Selected {name}@{entry['revision']}", flush=True)
