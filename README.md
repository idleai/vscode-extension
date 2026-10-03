# Idle for VS Code

VS Code host for Idle's workspace and history views, editor capture, and native
history actions. The TypeScript host lives here; shared application state lives
in `app-core`, and Rust/WASM rendering lives in `web-ui`.

Local history browsing and native actions are connected. Production session and
coordination integrations remain in progress; see the [assembly notes](docs/assembly.md).

## Setup

Use Node.js 22.12+ and rustup. [rust-toolchain.toml](rust-toolchain.toml) selects
Rust 1.97.0 and the required components and WASM target. Keep these sibling
checkouts under one parent directory:

```text
repos/
  vscode-extension/
  app-core/
  web-ui/
  editchain/
```

Cargo uses local path dependencies. The [CI workflow](.github/workflows/ci.yml)
records compatible sibling revisions.

Install the build tools and dependencies from this repository's root:

```sh
cargo install --locked wasm-bindgen-cli --version 0.2.127
cargo install --locked cargo-deny --version 0.20.2
npm ci
npm run build
```

## Run and package

Launch the **Idle Extension** debug configuration in VS Code, or build and install
the VSIX:

```sh
npm run package
code --install-extension idle.vsix
```

Packaging builds the extension and includes its JS, WASM and native services.
Native binaries match the build machine's OS and architecture; build for the
destination workspace host. Installed packages need no sibling source checkouts.

Open **Idle: Open Workspace** from the command palette. Native services require
Workspace Trust. Editor capture continues while views are closed; use
**Idle: Pause Editor Capture** or `idle.tracking.enabled` to control it.

## Checks

Run from the repository root:

```sh
npm test             # TypeScript host tests
./scripts/lint.sh    # Canonical Rust formatting, lint, tests and dependency checks
./scripts/check.sh   # Full Rust/host checks, packaging and VSIX smoke tests
```

After packaging, test the bundled views and native integration in Chrome:

```sh
CHROME_BIN=/absolute/path/to/chrome npm run test:webview
CHROME_BIN=/absolute/path/to/chrome npm run test:assembly
```

The root Idle extension uses packaged browser/native integration tests with a
simulated VS Code API. The existing EditChain History extension has a real VS Code
harness for actions and screenshots; see its [test commands](extensions/vscode-editchain/README.md#tests).

## Repository layout

| Path | Purpose |
| --- | --- |
| `extension/src/` | TypeScript activation, platform adapters and editor integration |
| `crates/` | Native services, editor protocol, capture and WASM integration |
| `extensions/vscode-editchain/` | Existing EditChain History extension and its desktop harness |
| `docs/` | Integration contracts and migration notes |

The existing extension also needs a sibling `codex/` checkout of
`idleai/codex-evo` for `tools/history-runtime`. Its
[README](extensions/vscode-editchain/README.md) covers builds and packaging;
the [import guide](docs/legacy-import.md) covers viewer data.

## Reference

- [Assembly and current integration status](docs/assembly.md)
- [Host APIs, peer providers and live relay testing](docs/host-integration.md)
- [Editor capture and archive replay](docs/editor-capture.md)
- [Native history actions](docs/native-history-actions.md)
- [Compatibility extension migration](extensions/vscode-editchain/ASSEMBLY-MIGRATION.md)
