#!/usr/bin/env bash
set -euo pipefail

curl --fail --silent --show-error --location --compressed --retry 3 \
  https://swift.org/keys/all-keys.asc --output "$RUNNER_TEMP/swift-signing-keys.asc"
gpg --batch --import "$RUNNER_TEMP/swift-signing-keys.asc"
swift_home="$RUNNER_TOOL_CACHE/swiftly-home"
swift_bin="$RUNNER_TOOL_CACHE/swiftly-bin"
mkdir -p "$swift_home" "$swift_bin"
echo "SWIFTLY_HOME_DIR=$swift_home" >> "$GITHUB_ENV"
echo "SWIFTLY_BIN_DIR=$swift_bin" >> "$GITHUB_ENV"
echo "$swift_bin" >> "$GITHUB_PATH"
for marker in "$RUNNER_TOOL_CACHE"/swiftly/*/*.complete; do
  [[ -f "$marker" ]] || continue
  if [[ ! -x "${marker%.complete}/swiftly" ]]; then rm -- "$marker"; fi
done

kotlin_dir="$RUNNER_TOOL_CACHE/idle-kotlin/2.2.0"
if [[ ! -x "$kotlin_dir/kotlinc/bin/kotlinc" ]]; then
  curl --fail --silent --show-error --location --retry 3 \
    https://github.com/JetBrains/kotlin/releases/download/v2.2.0/kotlin-compiler-2.2.0.zip \
    --output "$RUNNER_TEMP/kotlin-compiler.zip"
  echo "1adb6f1a5845ba0aa5a59e412e44c8e405236b957de1a9683619f1dca3b16932  $RUNNER_TEMP/kotlin-compiler.zip" | sha256sum --check
  mkdir -p "$kotlin_dir"
  unzip -q -o "$RUNNER_TEMP/kotlin-compiler.zip" -d "$kotlin_dir"
fi
echo "$kotlin_dir/kotlinc/bin" >> "$GITHUB_PATH"

boltffi_dir="$RUNNER_TOOL_CACHE/boltffi/0.31.0"
if [[ "$("$boltffi_dir/boltffi" --version 2>/dev/null || true)" != 'boltffi 0.31.0' ]]; then
  curl --fail --silent --show-error --location --retry 3 \
    https://github.com/boltffi/boltffi/releases/download/v0.31.0/boltffi-linux-x86_64.tar.gz \
    --output "$RUNNER_TEMP/boltffi.tar.gz"
  echo "e2a1801fbaff475ffb75228d84d3f07230a1faaf9fb1175a022aaf6be4d1824b  $RUNNER_TEMP/boltffi.tar.gz" | sha256sum --check
  mkdir -p "$boltffi_dir"
  tar -xzf "$RUNNER_TEMP/boltffi.tar.gz" -C "$boltffi_dir"
fi
test "$("$boltffi_dir/boltffi" --version)" = 'boltffi 0.31.0'
echo "$boltffi_dir" >> "$GITHUB_PATH"

chrome_output="$(npx --yes @puppeteer/browsers@3.2.3 install chrome@156.0.8078.47 --path "$RUNNER_TOOL_CACHE/idle-chrome")"
chrome_executable="$(printf '%s\n' "$chrome_output" | tail -n 1 | awk '{print $NF}')"
test -x "$chrome_executable"
echo "CHROME_BIN=$chrome_executable" >> "$GITHUB_ENV"

vscode_cache="$RUNNER_TOOL_CACHE/idle-vscode/1.140.0"
if [[ ! -f "$vscode_cache/.complete" || ! -x "$vscode_cache/VSCode-linux-x64/bin/code" ]]; then
  install_root="$(mktemp -d "$RUNNER_TEMP/idle-vscode.XXXXXX")"
  trap 'rm -rf "$install_root"' EXIT
  curl --fail --silent --show-error --location --retry 3 \
    https://update.code.visualstudio.com/1.140.0/linux-x64/stable -o "$install_root/archive.tar.gz"
  tar -xzf "$install_root/archive.tar.gz" -C "$install_root"
  test -x "$install_root/VSCode-linux-x64/bin/code"
  rm "$install_root/archive.tar.gz"
  mkdir -p "$(dirname "$vscode_cache")"
  rm -rf "$vscode_cache"
  mv "$install_root" "$vscode_cache"
  touch "$vscode_cache/.complete"
fi
echo "VSCODE_BIN=$vscode_cache/VSCode-linux-x64/bin/code" >> "$GITHUB_ENV"
