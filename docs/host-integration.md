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
SDK callbacks re-read a token for the originally selected account; only account
metadata reaches UI. `host.devTunnels()` lazily supplies pinned encrypted relay
streams, with local port forwarding disabled. Caller-supplied Rust/runtime code
owns authorization, invitations, peer protocol and reconnect decisions. The generic byte adapter pins the supplied relay key. The standalone sharing
adapter can explicitly refresh the endpoint of the same relay resource after
a host restart; native mutual TLS still requires the approved device certificate.

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
`extension/src/presence/contracts.ts`. Its serialized `publish` calls receive the
active repository-relative file and observed branch. The observer uses the
[built-in Git API](https://github.com/microsoft/vscode/blob/1.85.0/extensions/git/src/api/git.d.ts)
for the exact checkout, including repository removal and detached HEAD. It does
not read file contents or derive identity from Git authors. The adapter publishes
these observations under a bounded presence lease, renewing the latest observation
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

## Live relay probe

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
