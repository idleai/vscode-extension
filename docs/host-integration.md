# Host integration reference

Developer details for the TypeScript host, peer providers and Dev Tunnels.
For setup, builds and packaging, see the [root README](../README.md).

## Host services

`activate()` returns `HostServices`. Native feature modules use
`host.configuration.forResource(uri)` and `host.native.startPeer(uri)`;
capture, collection and native-history modules own their typed service clients. Every
native operation resolves an explicit open workspace folder. Relative chain
directories use that folder, and processes inherit its directory. Multi-root
windows never silently choose their first folder. Unsupported virtual filesystems
and untrusted workspaces cannot launch native adapters or access credentials.

The manifest declares `extensionKind: ["workspace"]`, so native adapters run with
the files in remote SSH, containers and Codespaces. See VS Code's
[workspace extension host documentation](https://code.visualstudio.com/api/advanced-topics/extension-host).
`idle.native.peerPath` overrides the packaged `editchain-peer` executable with an
absolute path. The package also contains `idle-history-service`,
`idle-editor-service`, `idle-history-collector` and `codex-session-exporter` for
its host platform. Capture and collection have corresponding explicit path settings.
Workspace build directories and the UI machine's PATH are not searched.

`host.effects.register(method, handler, requiresTrust)` installs an explicit
webview effect. Uninstalled actions fail as unavailable. The built-in methods
are `host.ready`, `configuration.read`, `output.show`, `notification.show`,
`clipboard.write` and `external.open`. Credentials, arbitrary commands, executable
paths and general native RPC are not webview methods. `external.open` accepts
HTTP(S) links without embedded credentials. Native history effects are installed
through `host.history` and require explicit engine bindings.

The Rust `webview::bridge` owns API acquisition, deferred `postMessage`, JSON
`getState`/`setState`, and disposable subscriptions. Envelope version 1 uses
`{protocol, session, id, method, params}`; replies contain `result` or
`error: {code, message}`, and events contain `event` and `params`. Requests are
limited to 1 MiB and 64 concurrent calls per view. Domain correlation, selection,
reconciliation, caches and rendering stay in the Rust libraries. The host uses
asset-only resource roots and a restrictive
[webview content security policy](https://code.visualstudio.com/api/extension-guides/webview#content-security-policy).

`host.credentials` adapts VS Code GitHub sessions and namespaced SecretStorage.
The packaged `idle-coordination` process owns sharing, Microsoft relay adapters,
reconnect policy, device approvals, discovery and cleanup. VS Code sends approved
commands over a private framed pipe and answers on-demand credential requests.
Each callback rechecks Workspace Trust and the selected account. Repository
discovery uses its separately approved GitHub session. Tokens never enter native
configuration, process arguments, status events or webview messages.

Sharing uses one native owner per physical folder, chain and account. Its private
state lock prevents two windows from owning the same saved session. Metadata and
configuration reads use the same Rust service library through a separate local
authority binding. Their webview allowlist excludes sharing and credential
commands. All network transports and peer policy remain in Rust.

Native journals keep exact resource ownership across suspension and failed
cleanup. The old VS Code marker journal remains solely for migration: active
window leases are respected, and a marker is removed only after native storage
acknowledges it. The native and upstream SDK suites check ownership, host keys,
transport backpressure, reconnection and cleanup. Extension tests exercise native
processes and production capture with a loopback relay fixture.

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
`extension/src/presence/contracts.ts`. Its serialized `publish` calls receive the
active repository-relative file and observed branch. The observer uses the
[built-in Git API](https://github.com/microsoft/vscode/blob/1.85.0/extensions/git/src/api/git.d.ts)
for the exact checkout, including repository removal and detached HEAD. It does
not read file contents or derive identity from Git authors. The adapter publishes
these observations under a bounded peer activity lease, renewing the latest observation
until the connection is aborted. `update` reconciles its app-core workspace view
and coordination directory without publishing; subscription echoes therefore
cannot trigger another publication. Keep one Rust `PeerAwareness` instance for
the installed connection. Apply the delivered invitation IDs with
`acknowledge_invitations`, then pass accepted inputs to `update` and return its
JSON view. Unacknowledged transitions retain their IDs across refreshes, with
current peer details and grants, until delivered or no longer applicable.
Reset the Rust baseline on recovery; IDs remain unique across resets.
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
state, calls `app_core::peer_activity::prepare_join`, and routes that exact intent
through the selected provider's existing authorization and transport. The helper returns
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
tested with app-core's `crates/app-core/tests/fixtures/peer-view.json` contract fixture, including
revocation, expiry, branch changes, multi-root isolation and cancellation.

## Live relay probe

With an existing `gh auth login` for GitHub, run the shared native probe explicitly:

```sh
npm run test:tunnels:live -- --github-auth
```

Alternatively set `IDLE_TUNNELS_GITHUB_TOKEN` in the probe environment. The probe
creates a private relay for two synthetic native stores, verifies authenticated
inventory exchange, reconnect and process restart, then requests owned-resource
deletion. It retains private native state if cleanup fails. Recovery uses that
printed state directory with the same account and the native service's `stop`
command. Credentials stay outside command arguments and configuration files.
The probe is not part of the default automated checks.
