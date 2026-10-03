#!/usr/bin/env bash
# Build and install from the target VS Code window's integrated terminal.
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'USAGE'
Usage: ./reinstall-vscode.sh [code|code-insiders|/path/to/code] [VS Code CLI options]

Build this checkout and install into the VS Code selected by this terminal.
Works with desktop and remote VS Code; keeps the terminal's connection settings.
Defaults to the first code or code-insiders executable on PATH.
Set EDITCHAIN_VSCODE_CLI or supply an executable to select another installation.
Extra CLI options are used for both installation and verification, for example:

  ./reinstall-vscode.sh
  ./reinstall-vscode.sh code-insiders
  ./reinstall-vscode.sh code --profile "Development"
  ./reinstall-vscode.sh /path/to/code --user-data-dir /path/to/user-data

Builds the current Idle extension and its shared host-tools packages.
USAGE
  exit 0
fi

editchain_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
editchain_invocation_dir="$PWD"
editchain_code="${EDITCHAIN_VSCODE_CLI:-}"
if [[ $# -gt 0 && "$1" != -* ]]; then
  editchain_code="$1"
  shift
fi
if [[ -z "$editchain_code" ]]; then
  # Honor PATH order across both channels, including the injected remote CLI.
  IFS=: read -r -a editchain_path <<< "$PATH"
  for editchain_directory in "${editchain_path[@]}"; do
    for editchain_name in code code-insiders; do
      editchain_candidate="${editchain_directory:-.}/$editchain_name"
      if [[ -f "$editchain_candidate" && -x "$editchain_candidate" ]]; then
        editchain_code="$editchain_candidate"
        break 2
      fi
    done
  done
fi
if [[ -z "$editchain_code" ]] || ! editchain_code="$(command -v "$editchain_code")"; then
  echo "VS Code CLI not found. Run from its integrated terminal or supply /path/to/code." >&2
  exit 1
fi
editchain_code="$(cd -- "$(dirname -- "$editchain_code")" && pwd)/$(basename -- "$editchain_code")"

# Keep VSCODE_IPC_HOOK_CLI so the CLI retains the terminal's remote connection.
echo "Using VS Code CLI: $editchain_code"
if ! "$editchain_code" "$@" --list-extensions >/dev/null; then
  echo "Cannot query VS Code. Check the CLI options or retry from a fresh integrated terminal." >&2
  exit 1
fi

cd "$editchain_root"
npm --prefix ../host-tools/packages/history-runtime ci
npm --prefix ../host-tools/packages/history-runtime run build
npm ci
npm run package
editchain_version="$(node -p 'require("./package.json").version')"
editchain_id="$(node -p 'const p = require("./package.json"); p.publisher + "." + p.name')"
editchain_vsix="$editchain_root/idle.vsix"

# Resolve relative CLI options against the same directory as the initial query.
cd "$editchain_invocation_dir"
"$editchain_code" "$@" --install-extension "$editchain_vsix" --force
"$editchain_code" "$@" --list-extensions --show-versions | rg -Fx "${editchain_id}@${editchain_version}"
echo "Build and installation complete. Reload the target VS Code window to load the extension."
