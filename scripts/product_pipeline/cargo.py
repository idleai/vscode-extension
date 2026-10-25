"""Select local Cargo packages and native artifacts for coordinated builds."""

from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tomllib


def metadata(root, environment, resolve=False):
    arguments = ["cargo", "metadata", "--format-version", "1"]
    if not resolve:
        arguments.append("--no-deps")
    else:
        arguments.append("--all-features")
    return json.loads(subprocess.check_output(arguments, cwd=root, env=environment, text=True))


@contextmanager
def environment_for(environment):
    previous = dict(os.environ)
    os.environ.clear()
    os.environ.update(environment)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(previous)


def candidates(producers, environment):
    registries, patches = {}, {}
    for producer in producers:
        package_registries = tomllib.loads((producer / ".cargo/config.toml").read_text()).get("registries", {})
        for name, settings in package_registries.items():
            if name in registries and registries[name] != settings:
                raise ValueError(f"conflicting registry definition: {name}")
            registries[name] = settings
        packages = metadata(producer, environment)["packages"]
        selected = False
        for package in packages:
            for registry in package.get("publish") or []:
                index = package_registries[registry]["index"]
                members = patches.setdefault(index, {})
                if package["name"] in members:
                    raise ValueError(f"two producers supply {package['name']}")
                members[package["name"]] = str(Path(package["manifest_path"]).parent)
                selected = True
        if not selected:
            raise ValueError(f"the selected producer has no published Cargo packages: {producer}")
    return registries, patches


def cargo_config(original, registries, patches):
    parsed = tomllib.loads(original)
    result = original + "\n"
    for name, settings in sorted(registries.items()):
        existing = parsed.get("registries", {}).get(name)
        if existing is not None:
            if existing.get("index") != settings["index"]:
                raise ValueError(f"conflicting original registry: {name}")
            continue
        result += f"\n[registries.{name}]\nindex = {json.dumps(settings['index'])}\n"
    for registry, members in sorted(patches.items()):
        if registry in parsed.get("patch", {}):
            raise ValueError(f"use an unpatched Cargo home for integration: {registry}")
        result += f"\n[patch.{json.dumps(registry)}]\n"
        for name, path in sorted(members.items()):
            result += f"{name} = {{ path = {json.dumps(path)} }}\n"
    return result


def resolver_for(root):
    path = root / "scripts/release_dependencies.py"
    if not path.exists():
        return None
    specification = importlib.util.spec_from_file_location("integration_release_dependencies", path)
    resolver = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(resolver)
    return resolver


def native_identity(archive):
    with tarfile.open(archive) as bundle:
        stream = bundle.extractfile("bundle.json")
        if stream is None:
            raise ValueError("native release is missing bundle.json")
        identity = json.load(stream)
    with archive.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    return (identity["repository"], identity["tag"].rsplit("-v", 1)[0]), {
        "tag": identity["tag"], "sha256": {identity["platform"]: checksum},
        "local_platform": identity["platform"],
    }
