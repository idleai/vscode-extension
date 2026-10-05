# Standalone history sharing

The extension host presents approvals and owns a coordination channel in the
packaged `idle-host` process. The shared Rust service owns invitations, outgoing
consent, replication, reconnect, discovery and Microsoft Dev Tunnels. Sharing
continues with every view closed.

Sign in with **Idle: Sign In to GitHub**. On the joining device, use **Copy History
Join Request** and give the request to the host. The host chooses **Host Shared
History**, reviews the device fingerprint and outgoing scope, then gives the
private invitation to that device. **Join Shared History** verifies the host and
asks for the joining device's outgoing scope before connecting.

Each command chooses an explicit folder in a multi-root workspace. Scope defaults
to records added from now on; including earlier history requires a separate
choice. **Change Shared History Scope** changes that choice without repeating
invitations. Receiving records leaves working-tree files alone and preserves the
local outgoing history boundary.

**Show History Sharing Status** follows native transfer counters automatically.
Percentages describe the current inventory pass, including records already
present. **Remove Shared History Device** revokes one device. **Stop History
Sharing** cancels pending approvals and removes saved automatic resumption for
the open folders. Closing the extension suspends existing sessions for recovery;
**Resume History Sharing** restores an approved session and reconnects it.

Native private storage holds saved invitations, reconnect grants and cleanup
records. Resumption is bound to the approving account, folder and resolved chain
path. Device keys keep their existing location in private global application
storage, outside the workspace and VSIX. Upgrading imports an earlier
SecretStorage session only after matching its account and verifying its device,
approved peers and existing engine scope. The previous copy remains until Rust
acknowledges durable storage. A repeated import cannot undo revocation or Stop.

VS Code supplies fresh GitHub credentials over the private process pipe when
requested. It checks Workspace Trust and account identity before returning them.
Tokens stay out of configuration files, command arguments, logs and webviews.
An account change or folder removal retires pending callbacks and drains the
native owner.

Dev Tunnels resources use native ownership journals. **Clean Up Dev Tunnels**
retries the current folders' pending deletions and imports inactive markers left
by the earlier extension for the current account. Migration respects leases held
by another window. Failed deletions remain durable for the next attempt.
Reconnecting can refresh the endpoint within the approved tunnel; native mutual
TLS verifies the approved device before exchanging records.

**Configure History Peer Discovery** optionally publishes public device and relay
details in a chosen GitHub repository. It requests repository access only after
confirmation and requires the sharing account. Discovery cannot enroll an unknown
device or move a private grant to another tunnel. A directory outage leaves
established replication running.

`npm test` runs the shared Rust coordinator and connection-state suites, then
checks the extension with native processes, mutual TLS, stores and the capture
service over a loopback test relay. It covers history/content transfer, recorder
rebuilds, scope changes, restart, revoked devices, Stop races, migration and
credential isolation. GitHub directory HTTP behavior and relay ownership checks
live beside their Rust implementations. The shared upstream SDK suite runs through
`host-tools/scripts/check.sh`. Default checks use synthetic histories without a
cloud account. The optional cloud probe is described in [host integration](host-integration.md#live-relay-probe).
