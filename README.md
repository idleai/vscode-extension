# vscode-extension

Initial scaffold for Idle. Module ownership, current behavior, and build
instructions are documented below; reserved modules are intentionally empty.

Thin TypeScript extension host with a Rust/WASM webview and a reserved native
adapter crate. The `Idle: Open Workspace` command reveals an Idle view in Explorer
and mounts the same scaffold component as the browser app. Capture, process
bridges, tunnels and session execution are not implemented here yet.

Keep sibling checkouts under one parent directory:

```text
repos/
  app-core/
  web-ui/
  vscode-extension/
  web/
  editchain/          # existing history engine and extraction source
  codex/              # existing idleai/codex-evo checkout
```

Path dependencies are deliberate during extraction. CI checks out the required
public siblings from `idleai/*` on `main`. The Cargo lockfile pins registry
dependencies, not sibling source revisions; coordinate boundary changes across
repositories. Once contracts are ready for release, replace sibling paths with
versioned packages or pinned Git revisions as a separate packaging change.

The `app-core` and `web-ui` siblings are required for builds. Installed VSIX files
include their JS/WASM/theme assets and need no sibling source checkout.

Rust 1.97.0 is selected by `rust-toolchain.toml`. Cargo installs the specified
toolchain/targets on first use; lockfiles are tracked. Install the dependency
policy checker once:

```sh
cargo install cargo-deny --locked --version 0.20.2
```

`./scripts/lint.sh` is the canonical Rust quality gate, shared by local checks and
CI: formatting, locked checks/Clippy/tests with all features, doctests, Rustdoc
and cargo-deny. Browser-facing libraries also run checks and Clippy for
`wasm32-unknown-unknown`. Every package inherits EditChain's strict workspace
Rust, Clippy and Rustdoc rules and its thresholds in `clippy.toml`.
`./scripts/check.sh` runs that gate followed by this repo's builds/packaging.

For the WASM bundle, install Node 22 and the exact matching bindgen CLI:

```sh
cargo install --locked wasm-bindgen-cli --version 0.2.127
```

The build respects Cargo's target directory and bundles generated JavaScript
snippets alongside WASM. It uses Cargo and the pinned wasm-bindgen CLI.

```sh
npm ci
npm run build
npm run package
bash scripts/check.sh
```

`npm run package` builds and writes `idle.vsix`. Install it with
`code --install-extension idle.vsix`, or use the checked-in `Idle Extension`
debug configuration. Packaging does not publish or install the extension.
The workspace extension runs on the file-owning host (including remote VS Code).

| Boundary | Owner after f1 |
| --- | --- |
| package.json, TypeScript host exports, `src/extension.ts`, `src/host/`, native manifest, CI | f38/extension-host |
| `src/capture/`, `native/src/capture.rs` | f39/editor-capture |
| `src/history/`, `native/src/history.rs` | f40/native-history-actions |
| `src/presence/` | f41/peer-awareness |
| `src/provenance/` | f42/provenance-decorations |
| webview manifest/entrypoint, WASM build/assets, shared view assembly | f43/extension-assembly |

The root Cargo workspace manifest is owned by f38; f43 owns changes specific to
its webview member. Coordinate npm manifest/script changes with f38.

Reuse `editchain/extensions/vscode-editchain/src/` editor capture, historical
providers, stdio messaging, credentials, multiplayer and Dev Tunnels adapters.
Retain VS Code-specific Rust conversion from `editchain-node/src/editor/` and
`editchain-protocol/src/editor*` in the native crate. Feature owners move those
implementations; f1 leaves the existing extension working in its current repo.

The dependency policy in `deny.toml` includes one explicit maintenance exception:
[RUSTSEC-2025-0141](https://rustsec.org/advisories/RUSTSEC-2025-0141.html), for
Crux 0.20's mandatory `bincode` 1.3.3 dependency. Remove it when Crux migrates
serialization. Other advisories remain checked. Crux's optional macro feature
is disabled, removing its unmaintained `proc-macro-error` dependency.
