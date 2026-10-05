# Idle for VS Code

VS Code host for Idle's workspace and history views, editor capture, and native
history actions. The TypeScript host lives here; shared application state lives
in `app-core`, Rust/WASM rendering lives in `web-ui`, and shared contracts,
capture/history services, collection and peer coordination live in `host-tools`.
The only Rust crate in this workspace is `idle-vscode-webview`, which mounts the
shared UI and connects it to the TypeScript host.

Workspace navigation, local metadata and peer activity, recorded Activity,
automatic collection, standalone peer sharing, configuration saves, shared
resource screens and native actions are connected. Git/GitHub data and recorded-session browsing
are being assembled; live session execution requires a runtime;
see the [assembly notes](docs/assembly.md).

## Setup

Use Node.js 22.12+, Python 3.12+ and rustup. [rust-toolchain.toml](rust-toolchain.toml)
selects Rust 1.97.0 and the required components and WASM target. Cargo downloads
versioned app-core, web-ui, host-tools and engine crates using `Cargo.lock` and
[the configured Cargo indexes](.cargo/config.toml). Normal CI checks out this
repository only.

`native-dependencies.json` records the engine, host-tools and exporter release
tags and SHA-256 checksums. Build scripts download the matching platform bundles
to `.artifacts/`, then copy production binaries into the extension package.

Install the build tools and dependencies from this repository's root:

```sh
cargo install --locked wasm-bindgen-cli --version 0.2.127
cargo install --locked cargo-deny --version 0.20.2
npm ci
npm run build
```

The full test suite installs the older peer compatibility fixture from the
host-tools release and runs its packaged coordinator tests. `npm test` prepares
these tools automatically. They are absent from the shipped extension.

## Run and package

Launch the **Idle Extension** debug configuration in VS Code, or build and install
the VSIX:

```sh
npm run package
code --install-extension idle.vsix
```

Packaging builds the extension and includes its JS, WASM and native services.
The VSIX contains two native executables: `idle-host` and
`codex-session-exporter`. One `idle-host` process serves all workspace capture,
history, collection, repository and coordination channels. The exporter runs
only when collection needs it. Configure `idle.native.hostPath` to use a custom
host, then run **Idle: Restart Native Adapters**. The old capture, history and
collector executable settings are deprecated.
Native binaries match the build machine's OS and architecture; build for the
destination workspace host. Installed packages need no sibling source checkouts.

Open **Idle** from the Activity Bar or **Idle: Open Workspace** from the command palette. Native services require
Workspace Trust. Editor capture continues while views are closed; use
**Idle: Pause Editor Capture** or `idle.tracking.enabled` to control it.
Repository access reuses an existing authorized VS Code GitHub session. If more
permissions are needed, **Connect GitHub repository access** uses VS Code's
GitHub Authentication provider. Remote SSH windows offer **Use device code**
when supported, avoiding the browser redirect back to VS Code. Selecting it
saves VS Code's **GitHub Authentication: Prefer Device Code Flow** preference.
Each open view reloads its selected folder after approval. Failed or cancelled
sign-in can be retried; the Idle output records the result without credentials.
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
| `crates/idle-vscode-webview/` | Rust/WASM entrypoint and webview bridge for app-core/web-ui |
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
GitHub access uses VS Code authentication and the repository service inside
`idle-host`. The repository access button explicitly requests repository scope.
Public/offline/partial reads and retry deadlines remain visible. Session selection
is retained separately for sidebar and detail under the exact repository binding.
No runtime is required to browse captured sessions; execution remains unavailable
until a runtime is connected. See the shared
[repository adapter contract](https://github.com/idleai/host-tools/blob/main/docs/repository.md).
The **Update released artifacts** workflow checks for compatible internal
packages and complete native/consumer archives every 15 minutes, or on manual
request. It groups lockfile versions and archive checksums in one generated PR
and starts the full CI workflow. Successful CI for the current bot commit allows
a fast-forward into `main`, preserving the exact tested commit. If `main` has
advanced, the updater refreshes the PR and CI runs again. Failed or incompatible
updates stay open for review. Ordinary feature PRs and third-party Dependabot PRs
retain their normal review process. CI files contain no sibling checkout commits
to advance after each producer change.


Dependabot requires a secret reference for custom Cargo registries, including
public ones. Set the repository's Dependabot secret `PUBLIC_CARGO_REGISTRY_TOKEN`
to the literal value `anonymous`. This is a public marker, not an access token;
the GitHub indexes remain anonymously readable.

## Coordinated development

For ordinary local Rust work, add a temporary Cargo patch for the relevant
registry and pass it with `cargo --config /absolute/path/local.toml ...`.
Keep these overrides out of committed manifests and lockfiles. Full checks with
an unpublished producer can use `memos/scripts/check-integration.py` with
explicit `--producer` and `--consumer` checkout paths. It temporarily patches
Cargo, builds candidate native bundles when needed, runs the consumer's normal
check script and restores its dependency files. The manual **Unpublished package
integration** workflow in memos runs the same check for selected branches.

## Automatic package releases

A successful `main` CI run starts the Release workflow. Release-plz calculates
versions and changelogs, and automation commits that metadata to `main`. The
entire CI workflow checks the version commit before any package is published.
Package archives, indexes and native bundles then publish from that exact commit;
there is no separate release PR. Concurrent changes to `main` are never overwritten.

Declare breaking changes in the feature PR, including the required minimum
versions in consumers. Release-plz uses commit messages and Rust API checks to
calculate the next version. To recover a failed publication, use **Re-run failed
jobs** on that Release run, retaining its verified commit even if `main` has
advanced. Dispatch **Release** on `main` to prepare current changes or resume a
current version commit. Existing versions and public archives remain immutable;
retries can complete unfinished drafts. A documentation-only change that does not alter packaged
contents does not create another package version.
