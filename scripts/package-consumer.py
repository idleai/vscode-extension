#!/usr/bin/env python3
"""Package the Rust entrypoint for downstream compatibility checks."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tomllib

root = Path(__file__).resolve().parent.parent
manifest = tomllib.loads((root / "crates/idle-vscode-webview/Cargo.toml").read_text())
package = manifest["package"]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--tag", default=f"{package['name']}-v{package['version']}")
parser.add_argument("--allow-dirty", action="store_true")
args = parser.parse_args()
if args.tag != f"{package['name']}-v{package['version']}":
    raise ValueError("release tag must match the consumer package version")
subprocess.run(["cargo", "package", "--locked", "--all-features", "--registry", "idle-app-core",
                *(["--allow-dirty"] if args.allow_dirty else []), "-p", package["name"]],
               cwd=root, check=True)
metadata = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"], cwd=root))
directory = root / "releases"
directory.mkdir(exist_ok=True)
filename = f"{package['name']}-{package['version']}.crate"
archive = directory / filename
shutil.copyfile(Path(metadata["target_directory"]) / "package" / filename, archive)
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(directory / (filename + ".sha256")).write_text(f"{checksum}  {filename}\n")
print(archive)
