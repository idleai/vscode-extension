# Standalone history sharing

Sharing belongs to the extension host and continues with every view closed.
It uses the existing portable coordinator from `host-tools/packages/history-runtime`,
Rust connection helpers from host-tools, the generic EditChain peer executable and
the host's Dev Tunnels adapters. It does not start an agent execution service.

Sign in with **Idle: Sign In to GitHub**. On the joining device, use **Copy History
Join Request** and give the request to the host. The host chooses **Host Shared
History**, reviews the device fingerprint and outgoing scope, then gives the
private invitation to that device. **Join Shared History** verifies the host and
asks for the joining device's outgoing scope before connecting.

Each command chooses an explicit folder in a multi-root workspace. Scope defaults
to records added from now on; including earlier history requires a separate
choice. **Change Shared History Scope** changes that choice without repeating
invitations. Receiving records never changes working-tree files or supplies
permission to forward locally withheld records.

**Show History Sharing Status** follows public transfer counters automatically.
Percentages describe the current inventory pass, including records already
present. **Remove Shared History Device** revokes one device. **Stop History
Sharing** cancels pending approvals and removes saved automatic resumption for
the open folders. Closing the extension suspends existing sessions for recovery;
**Resume History Sharing** restores an approved session and reconnects it.

Private invitations and reconnect grants stay in SecretStorage. Resumption is
bound to the approving account, folder and resolved chain path. Changing a chain
does not transfer its approval to the new destination. An account change or
folder removal retires pending callbacks. Device keys remain in private global
application storage, outside the workspace and VSIX.

Dev Tunnels resource ownership uses the account-scoped journal. **Clean Up Dev
Tunnels** selects inactive resources for the current account. Reconnecting can
refresh the relay endpoint for the same tunnel after its host restarts; native
mutual TLS still verifies the approved device before exchanging records.

**Configure History Peer Discovery** optionally publishes public device and relay
details in a chosen GitHub repository. It requests repository access only after
confirmation. Discovery cannot enroll an unknown device or move a private grant
to another tunnel, and a directory outage does not stop established replication.

`npm test` builds the peer-state bindings and native fixture tools. The sharing
tests use the real coordinator, Rust state, mutual TLS, stores and capture service
with an injected byte transport. Platform tests cover encrypted streams, late
cleanup, endpoint refresh, account changes, consent and Stop/reload races. These
checks use temporary synthetic histories and do not connect to a cloud account.
