# Idle for VS Code

VS Code host for Idle's workspace and history views, editor capture, and native
history actions. The TypeScript host lives here; shared application state lives
in `app-core`, Rust/WASM rendering lives in `web-ui`, and shared contracts,
collection and peer coordination live in `host-tools`.

Workspace navigation, local metadata and presence, recorded Activity, automatic
collection, standalone peer sharing, configuration saves, shared resource screens
and native actions are connected. Git/GitHub data and recorded-session browsing
are being assembled; live session execution requires a runtime;
see the [assembly notes](docs/assembly.md).

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
  host-tools/           # shared contracts, collection and peer coordination
  codex/                # tools/codex-session-exporter
```

Cargo uses local path dependencies. The [CI workflow](.github/workflows/ci.yml)
records compatible sibling revisions.

Install the build tools and dependencies from this repository's root:

```sh
cargo install --locked wasm-bindgen-cli --version 0.2.127
cargo install --locked cargo-deny --version 0.20.2
npm --prefix ../host-tools/packages/history-runtime ci
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
Codex import and chain-change monitoring also run with views closed. Use
**Idle: Pause Agent History Import** or `idle.live.enabled` to pause collection.

Native text editors show author and exposure observations for exact recorded
revisions. Hover the indicators or use **Idle: Show Author and Exposure Sources**
for recorded files, diffs and source records. Configure `idle.decorations.enabled`
per resource; missing observations remain explicit.

Standalone sharing uses **Idle: Copy History Join Request**, **Host Shared History**
and **Join Shared History**. Each selected folder has its own chain, device
approval and outgoing history scope. **Stop History Sharing** removes automatic
resumption; closing views keeps replication running. See [sharing](docs/sharing.md).

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

The packaged browser/native checks use a simulated VS Code API, real browser
rendering and the bundled native services. Native sharing tests use real mutual
TLS and durable stores with an injected byte transport.

To verify the installed extension in a disposable desktop VS Code profile on
Linux, with `xvfb-run` available:

```sh
VSCODE_BIN=/absolute/path/to/code npm run test:vscode
```

This check uses its own workspace, settings and extension directory.

## Repository layout

| Path | Purpose |
| --- | --- |
| `extension/src/` | TypeScript activation, platform adapters and editor integration |
| `crates/` | Native services, editor protocol, capture and WASM integration |
| `docs/` | Platform host, capture, history actions and sharing contracts |

## Reference

- [Assembly and current integration status](docs/assembly.md)
- [Host APIs, peer providers and live relay testing](docs/host-integration.md)
- [Editor capture and archive replay](docs/editor-capture.md)
- [Native history actions](docs/native-history-actions.md)
- [Author and exposure decorations](docs/author-activity-decorations.md)
- [Shared collection and import tools](https://github.com/idleai/host-tools)
- [Standalone history sharing](docs/sharing.md)

Standalone repository surfaces now show Git checkout/worktree details, bounded
Git authors and GitHub contributors/collaborators, issues/PRs, failed HEAD checks,
explicit triage/input requests, and local/imported recorded sessions. GitHub
source pages open through the host; exact response records open in Activity.
GitHub access uses VS Code authentication and the packaged `idle-repository`
reader. The repository access button explicitly requests repository scope.
Public/offline/partial reads and retry deadlines remain visible. Session selection
is retained separately for sidebar and detail under the exact repository binding.
No runtime is required to browse captured sessions; execution remains unavailable
until a runtime is connected. See the shared
[repository adapter contract](../host-tools/docs/repository.md).
