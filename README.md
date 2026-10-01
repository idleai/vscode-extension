# vscode-extension

The TypeScript host lives in `extension/src/`. The root Cargo workspace contains
`crates/idle-vscode-native/` and `crates/idle-vscode-webview/`. Build, test and package
commands still run from the repository root and emit `out/`, `dist/` and `idle.vsix`.

Idle's thin TypeScript workspace host, with application state in `app-core` and
shared Rust/WASM rendering in `web-ui`. Activation installs commands, configuration,
sidebar/detail webviews, output/status/notifications, credentials, native IPC and
Dev Tunnels adapters. Opening either view currently mounts the shared bootstrap
component; editor capture, history actions and complete workspace UI assembly have
separate feature owners below.

Activation performs no authentication, native launch or network connection.
Platform services live until extension deactivation, independently of view
lifetimes. Each view receives a fresh protocol session; closing it cancels its
pending calls and discards late responses without stopping native services.

## Host integration

`activate()` returns `HostServices`. Native feature modules use
`host.configuration.forResource(uri)`, `host.native.request(uri, body)`,
`host.native.requestJson(uri, bytes)`, and `host.native.startPeer(uri)`. Every
native operation resolves an explicit open workspace folder. Relative chain
directories use that folder, and processes inherit its directory. Multi-root
windows never silently choose their first folder. Unsupported virtual filesystems
and untrusted workspaces cannot launch native adapters or access credentials.

The manifest declares `extensionKind: ["workspace"]`, so native adapters run with
the files in remote SSH, containers and Codespaces. See VS Code's
[workspace extension host documentation](https://code.visualstudio.com/api/advanced-topics/extension-host).
`idle.native.servicePath` and `idle.native.peerPath` are absolute paths on that
host. Empty settings resolve `bin/<platform>-<arch>/editchain-vscode-service`
and `editchain-peer` (with `.exe` on Windows). **This feature does not yet ship
native binaries**; configure built compatible executables until f43 packages them.
Workspace build directories and the UI machine's PATH are not searched.

`host.effects.register(method, handler, requiresTrust)` installs an explicit
webview effect. Uninstalled actions fail as unavailable. The built-in methods
are `host.ready`, `configuration.read`, `output.show`, `notification.show`,
`clipboard.write` and `external.open`. Credentials, arbitrary commands, executable
paths and general native RPC are not webview methods. `external.open` accepts
HTTP(S) links without embedded credentials. File/revision/diff actions arrive
through f40's explicit engine bindings.

The Rust `webview::bridge` owns API acquisition, deferred `postMessage`, JSON
`getState`/`setState`, and disposable subscriptions. Envelope version 1 uses
`{protocol, session, id, method, params}`; replies contain `result` or
`error: {code, message}`, and events contain `event` and `params`. Requests are
limited to 1 MiB and 64 concurrent calls per view. Domain correlation, selection,
reconciliation, caches and rendering stay in the Rust libraries. The host uses
asset-only resource roots and a restrictive
[webview content security policy](https://code.visualstudio.com/api/extension-guides/webview#content-security-policy).

`host.credentials` adapts VS Code GitHub sessions and namespaced SecretStorage.
SDK callbacks re-read a token for the originally selected account; only account
metadata reaches UI. `host.devTunnels()` lazily supplies pinned encrypted relay
streams, with local port forwarding disabled. Caller-supplied Rust/runtime code
owns authorization, invitations, peer protocol and reconnect decisions. The
adapter never refreshes an approved endpoint to an unapproved host key.

Tunnel shutdown suspends established leases and removes incomplete new hosts;
explicit `stop()` deletes a resource. An account-scoped journal retains cleanup
markers, checks known active window/process leases and releases them on shutdown.
It is a local VS Code cleanup journal, not a distributed ownership service.
Cancelled SDK calls dispose late streams/resources, and failed cleanup remains
retryable. SDK SSH disconnect/close events terminate the owned Node streams;
destroying a V2 stream also disposes its encryption session. Default automated
tests use injected SDKs and real local encrypted SSH
streams. The opt-in live probe below exercises the migrated adapters against the
Microsoft relay with both endpoints on one machine.

Commands: **Open Workspace**, **Open Detail View**, **Show Output**, **Open Extension
Settings**, **Restart Native Adapters**, **Sign In to GitHub**, **Show File Peers**, and **Clean Up Dev
Tunnels** (all prefixed `Idle:`). Restart closes adapters; their next operation
starts them again. Cleanup selects inactive resources for the current account.

## File peers and invitations

The native editor header uses CodeLens to show each fresh same-file connection's
contributor name, branch, host label and supplied work summary. **Idle: Show File
Peers**, the header and the peer count in the status bar open the same picker.
Session and host join choices remain separate. Missing summaries, branches and
hosts are left unknown; a host owner is never substituted for a contributor.

`host.presence.connect(binding, provider)` installs the selected standalone or
managed coordination adapter. `binding` contains an explicit checkout URI and
app-core's workspace/repository/chain binding, mode and authenticated connection
identity. There is no first-folder fallback or repository inference from remote
URLs. Replacing the binding, changing accounts or removing folders cancels old
work and clears the UI. The returned disposable releases only its own binding.
Awareness survives closing sidebar/detail views and stops at host shutdown.

The provider implements `PeerAwarenessProvider` in
`extension/src/presence/contracts.ts`. Its serialized `update` calls receive the
active repository-relative file and observed branch. The observer uses the
[built-in Git API](https://github.com/microsoft/vscode/blob/1.85.0/extensions/git/src/api/git.d.ts)
for the exact checkout, including repository removal and detached HEAD. It does
not read file contents or derive identity from Git authors. The adapter publishes
these observations under a bounded presence lease and reconciles its app-core
workspace view and coordination directory. Pass those accepted inputs to
`idle_vscode_native::presence::PeerAwareness::update` and return its JSON view.
Explicit connection/session associations must come from coordination; shared
ownership or a shared host does not establish a session association.

The Rust projection uses the published `app-core` workspace types and
`idle-protocol` grants, sessions and host publications. It filters revoked,
offline, expired and foreign-repository connections. It reports transitions
when a known peer switches to the local branch, or the local checkout switches
to a known peer's branch. Known same-host connections need no convergence prompt;
an unknown host label does not hide an observed branch change. Initial discovery, detached/unknown
branches, reconnects and recovery stream changes establish a baseline without
branch notifications. Peer summaries remain exactly the supplied records.

Join choices reference an existing `Observe` session grant or `Connect` compute
grant for the current contributor. On selection, the adapter refreshes shared
state, calls `presence::prepare_join`, and routes that exact intent through the
selected provider's existing authorization and transport. The helper returns
current discovery references and session runtime identity; it does not issue
credentials or grants. The authority and runtime still authenticate, authorize
and enforce revocation, including on established connections. A session grant
does not authorize general host access; connecting to a host does not authorize
file writes or process execution. Only a runtime-confirmed connection returns
`connected`; a coordination receipt returns `pending`.

The host discards delayed responses and stale picker choices, cancels joins on
invalidation, and clears views at their freshness deadline while refreshing.
Both modes share this integration port. f43 installs the production connections
alongside app-core selection/subscription assembly; f18 and f52 supply their
standalone and managed services. Until an adapter is installed, **Show File
Peers** reports unavailable. No production fixture or implicit network
connection is installed. The native projection and both host adapter modes are
tested with the same `test/fixtures/peer-view.json` contract fixture, including
revocation, expiry, branch changes, multi-root isolation and cancellation.

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

For the WASM bundle and host tooling, install Node 22.12 or newer and the exact matching bindgen CLI:

```sh
cargo install --locked wasm-bindgen-cli --version 0.2.127
```

The build respects Cargo's target directory and bundles generated JavaScript
snippets alongside WASM. It uses Cargo and the pinned wasm-bindgen CLI.

```sh
npm ci
npm test
npm run build
npm run package
bash scripts/check.sh
```

`npm test` covers activation, trust/account boundaries, session-isolated webview
messages, real child process cleanup, framing/backpressure, and encrypted tunnel
lifecycle/cleanup. `scripts/check.sh` runs those tests as well as the canonical
Rust gate and VSIX build. An optional isolated Chromium check exercises the WASM
and CSP extracted from the VSIX, without using a signed-in browser:

```sh
CHROME_BIN=/absolute/path/to/chrome npm run test:webview
```

With an existing `gh auth login` for GitHub, run the cloud probe explicitly:

```sh
npm run test:tunnels:live
```

This creates a temporary private tunnel, verifies 1 MiB of synthetic bytes in each
direction, suspends/resumes its host, reconnects with the approved new key, rejects
the previous host key, cancels a live port wait, and deletes the tunnel. It
checks the service independently for remaining resources. Credentials and relay
descriptors stay in memory; only cleanup markers are persisted in the printed
temporary journal path. The probe does not read or transmit workspace files.
If cleanup fails or the process is killed, retain that journal and, after the
original process has exited, retry with the same GitHub account:

```sh
npm run test:tunnels:live -- --cleanup /path/from/probe/cleanup.json
```

The live probe is separate from CI. It does not cover another machine/network,
another account, or the assembled multiplayer UI in VS Code.

The host bundle includes its runtime dependencies; the VSIX contains only that
bundle, notices and web assets (plus native artifacts when supplied under `bin`).
The Dev Tunnels SDK pins match the extraction source. Its `uuid` dependency is
overridden to 11.1.1 to address its advisory; the SDK's `v4()` calls are covered by
an actual SDK construction/disposal test. `node-rsa` supplies the SDK's undeclared
legacy fallback so bundling leaves no unresolved import for it. Supported VS Code
hosts use Node's native RSA implementation.

`npm run package` builds and writes `idle.vsix`. Install it with
`code --install-extension idle.vsix`, or use the checked-in `Idle Extension`
debug configuration. Packaging does not publish or install the extension.
The workspace extension runs on the file-owning host (including remote VS Code).

| Boundary | Owner after f1 |
| --- | --- |
| package.json, TypeScript host exports, `extension/src/extension.ts`, `extension/src/host/`, native manifest, CI | f38/extension-host |
| `extension/src/capture/`, `crates/idle-vscode-native/src/capture.rs` | f39/editor-capture |
| `extension/src/history/`, `crates/idle-vscode-native/src/history.rs` | f40/native-history-actions |
| `extension/src/presence/`, `crates/idle-vscode-native/src/presence/` | f41/peer-awareness |
| `extension/src/provenance/` | f42/provenance-decorations |
| webview manifest/entrypoint, WASM build/assets, shared view assembly | f43/extension-assembly |

The root Cargo workspace manifest is owned by f38; f43 owns changes specific to
its webview member. Coordinate npm manifest/script changes with f38.

## Extraction ownership

The host primitives were adapted from EditChain's `stdioClient.ts`,
`frameDecoder.ts`, activation/commands/account adapters, `multiplayer/relay.ts`,
`multiplayer/native.ts`, `devTunnels/spike.ts`, and renderer `shell/runtime.rs`.
The complete legacy extension remains temporarily executable for its capture and
history consumers. Its `HOST-MIGRATION.md` records the source mappings and cleanup
owners. f39 moves capture/conversion, f40 moves document/history actions, f43
switches UI consumers and retires the old host; f18/f23/f28 own coordination and
shared Rust state. No legacy domain or rendering state was copied into TypeScript.

The dependency policy in `deny.toml` includes one explicit maintenance exception:
[RUSTSEC-2025-0141](https://rustsec.org/advisories/RUSTSEC-2025-0141.html), for
Crux 0.20's mandatory `bincode` 1.3.3 dependency. Remove it when Crux migrates
serialization. Other advisories remain checked. Crux's optional macro feature
is disabled, removing its unmaintained `proc-macro-error` dependency.
