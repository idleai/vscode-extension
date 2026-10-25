"""Build Cargo components together and retain the exact native and desktop artifacts."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess

from . import cargo as cargo_sources
from .records import Timings, digest, write
from .sources import read


NAMES = ["editchain", "host-tools", "app-core", "web-ui", "vscode-extension"]



def run(root, environment, *arguments):
    subprocess.run(arguments, cwd=root, env=environment, check=True)


def pinned_artifacts(root, resolver, local_native):
    snapshot = json.loads((root / ".github/released-dependencies.lock.json").read_text())["artifacts"]
    artifacts = {}
    for filename in resolver.MANIFESTS:
        path = root / filename
        if not path.exists():
            continue
        document = json.loads(path.read_text())
        selected = {}
        for name, dependency in document["dependencies"].items():
            candidate = local_native.get((dependency["repository"], dependency["package"]))
            if candidate is not None and filename == "native-dependencies.json":
                selection = dict(dependency, **candidate)
            else:
                selection = snapshot[filename]["dependencies"][name]
                if any(selection.get(key) != dependency[key] for key in ["repository", "package", "version"]):
                    raise ValueError(f"refresh the committed artifact selection for {root.name}/{name}")
            version = selection["tag"].removeprefix(f"{dependency['package']}-v")
            if not resolver.matches(dependency["version"], tuple(map(int, version.split(".")))):
                raise ValueError(f"candidate does not satisfy {root.name}/{name}: {dependency['version']}")
            selected[name] = selection
        artifacts[filename] = {"schema": 1, "dependencies": selected}
    return artifacts


def local_packages(metadata, roots):
    selected = []
    for package in metadata["packages"]:
        manifest = Path(package["manifest_path"]).resolve()
        owner = next((root.name for root in roots if manifest.is_relative_to(root)), None)
        source = package.get("source") or ""
        if "raw.githubusercontent.com/idleai/" in source:
            raise ValueError(f"{package['name']} still resolves to a published internal package: {source}")
        if owner:
            selected.append({"name": package["name"], "version": package["version"], "repository": owner,
                             "manifest": str(manifest.relative_to(next(root for root in roots if root.name == owner)))})
    return sorted(selected, key=lambda package: (package["repository"], package["name"]))


@contextmanager
def cargo_environment(sources, output, plan):
    roots = [sources / name for name in NAMES]
    original_cargo = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")).resolve()
    cargo = sources.parent / "cargo-home"
    cargo.mkdir(exist_ok=True)
    for name in ["bin", "registry", "git"]:
        source, destination = original_cargo / name, cargo / name
        if source.exists() and not destination.exists():
            destination.symlink_to(source, target_is_directory=True)
    original_path = original_cargo / "config.toml"
    original = original_path.read_text() if original_path.exists() else ""
    target = sources.parent / "cargo-target"
    target.mkdir(exist_ok=True)
    for root in roots:
        link = root / "target"
        if not link.exists():
            link.symlink_to(target, target_is_directory=True)
        if link.resolve() != target.resolve():
            raise ValueError(f"expected the product's shared Cargo output directory: {root}")
    environment = dict(os.environ, CARGO_HOME=str(cargo), CARGO_TARGET_DIR=str(target),
                       IDLE_PRODUCT_INPUTS=str(plan), IDLE_ARTIFACTS_MIRROR=str(output / "native"))
    environment.pop("IDLE_RELEASE_INPUTS", None)
    registries, patches = cargo_sources.candidates(roots[:-1], environment)
    local_native = {}

    def resolve(root):
        config = cargo / "config.toml"
        config.write_text(cargo_sources.cargo_config(original, registries, patches))
        resolver = cargo_sources.resolver_for(root)
        if resolver is not None:
            # A locked older release can win until Cargo updates that package.
            # Keep every candidate available while making this selection.
            with cargo_sources.environment_for(environment):
                resolver.update_cargo(root)
        metadata = cargo_sources.metadata(root, environment, resolve=True)
        paths = {str(Path(package["manifest_path"]).parent) for package in metadata["packages"]
                 if not Path(package["manifest_path"]).is_relative_to(root)}
        needed = {registry: {name: path for name, path in packages.items() if path in paths}
                  for registry, packages in patches.items()}
        config.write_text(cargo_sources.cargo_config(original, registries,
                          {registry: packages for registry, packages in needed.items() if packages}))
        metadata = cargo_sources.metadata(root, environment, resolve=True)
        selected = dict(environment)
        if resolver is not None:
            with cargo_sources.environment_for(selected):
                resolver.capture(root, pinned_artifacts(root, resolver, local_native))
            record = output / "dependencies" / f"{root.name}.json"
            record.parent.mkdir(exist_ok=True)
            shutil.copy2(root / "target/released-dependencies.json", record)
            selected.update(IDLE_RELEASE_INPUTS=str(record), IDLE_LOCAL_RELEASE_INPUTS="1")
        packages = local_packages(metadata, roots)
        write(output / "selections" / f"{root.name}.json", packages)
        return selected

    yield resolve, local_native


def build(plan, sources, output):
    document = read(plan)
    output.mkdir(parents=True, exist_ok=True)
    (output / "native").mkdir(exist_ok=True)
    shutil.copy2(plan, output / "product-inputs.json")
    timings = Timings(output / "cargo-timings.json")
    with cargo_environment(sources, output, plan) as (resolve, local_native):
        for name in NAMES:
            root = sources / name
            with timings.step(f"{name}: select source dependencies"):
                actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
                if actual != document["repositories"][name]["revision"]:
                    raise ValueError(f"source revision mismatch: {name}")
                environment = resolve(root)
            with timings.step(f"{name}: canonical checks"):
                if name == "host-tools":
                    run(root, environment, "npm", "--prefix", "packages/history-runtime", "ci")
                elif name in ["web-ui", "vscode-extension"]:
                    run(root, environment, "npm", "ci")
                script = "scripts/lint.sh" if name == "editchain" else "scripts/check.sh"
                run(root, environment, "bash", script)
            if name in ["editchain", "host-tools"]:
                with timings.step(f"{name}: native bundle"):
                    before = set((output / "native").glob("*.tar.gz"))
                    run(root, environment, "python3", "scripts/package-native.py", "--output", str(output / "native"))
                    created = set((output / "native").glob("*.tar.gz")) - before
                    if len(created) != 1:
                        raise ValueError(f"expected one new native bundle from {name}")
                    archive = created.pop()
                    identity, selected = cargo_sources.native_identity(archive)
                    local_native[identity] = selected
            if name == "web-ui":
                with timings.step("web-ui: browser checks"):
                    for fixture in ["history", "history-details", "history-explorer", "sessions", "projections", "navigation"]:
                        run(root, environment, "bash", f"scripts/build-{fixture}.sh")
                        run(root, environment, "npm", "run", f"test:{fixture}:browser")
            if name == "vscode-extension":
                with timings.step("vscode-extension: packaged browser and desktop checks"):
                    for script in ["test:webview", "test:assembly", "test:vscode"]:
                        run(root, environment, "npm", "run", script)
                shutil.copy2(root / "idle.vsix", output / "idle.vsix")
    write(output / "cargo-result.json", {"schema": 1, "product_id": document["id"], "result": "success",
                                        "vsix_sha256": digest(output / "idle.vsix")})
