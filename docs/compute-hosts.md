# Connect a Codex compute host

VS Code connects to the compute machine through Dev Tunnels. The daemon keeps
running when the editor closes. You can attach a workspace, inspect its status
and explicitly move workspace coordination to that daemon. Agent execution and
general file and process actions are separate work.

## Build the matching changes

Use the `evo1/coordination-owner` branches in `idleai/codex-evo`,
`idleai/host-tools` and this repository. Build `codex` from the Codex fork and
`idle-host` from host-tools. Build/install this extension using the normal
[setup instructions](../README.md#setup).

The released native host supports attachment and status. To use coordination
ownership before the companion changes are released, set **Idle: Native Host Path**
(`idle.native.hostPath`) to your new `idle-host` executable on the machine
running the extension. The extension checks the native host and daemon's
capabilities before moving coordination.

## Pair the workspace

1. Open the client workspace in a trusted VS Code window. Select it in Idle,
   then run **Idle: Copy Compute Connection Request**. The command copies public
   workspace and client identifiers. Save that JSON as `request.json` on the
   compute machine.
2. On the compute machine, sign in using GitHub CLI (`gh auth login`) if needed.
   Start the updated Codex daemon: `codex app-server daemon start`.
3. Approve the request using existing directories on the compute machine:

   ```sh
   codex app-server idle host --request request.json \
     --checkout-root /absolute/checkout --chain-directory /absolute/chain \
     --relay-helper /absolute/idle-host --github-cli /absolute/gh \
     --output /private/new-invitation.txt
   ```

   The output file must be new. Keep its contents private; it contains the
   connection credentials. The command prints the grant ID for later revocation.
4. Run **Idle: Connect Compute Host** in VS Code and paste the invitation. It is
   stored in VS Code secret storage. **Compute hosts** displays
   **Codex on &lt;machine name&gt;** with the daemon's current availability.

The request binds this client workspace to the approved server checkout. It
does not copy files or enable history sharing. Each invitation belongs to the
named VS Code installation; use a new request for another installation.

## Move workspace coordination

1. Sync the tracked `.idle/workspace` definitions to the compute checkout. The
   transfer checks that both checkouts have exactly the same definitions before
   it changes ownership; it does not copy or overwrite repository files.
2. Create a new invitation using the pairing command above with the additional
   `--coordination-owner` flag. This grants the named installation permission to
   transfer and use coordination for that checkout. A normal invitation permits
   attachment and status only.
3. Paste that invitation into **Idle: Connect Compute Host**, then run
   **Idle: Move Workspace Coordination to Compute Host**.

The transfer preserves workspace revisions, access grants, change cursors and
recorded write results. It retires the current control lease; a controller must
acquire a new lease from the daemon. Configuration changes now update
`.idle/workspace` in the compute checkout. Sync those tracked files back through
your normal repository workflow when needed.

The editor's private coordinator freezes before transfer. It keeps a durable
route to the selected daemon and cannot resume local writes. If the connection
drops during transfer, reconnect and run the same command again; the transfer
keeps its original ID and safely accepts a repeated acknowledgement. This also
works after restarting either process. Closing the editor leaves the daemon's
coordinator running. The daemon restores the coordinator and its saved state
after a restart without needing the editor to be open.

An unavailable host, expired grant, revoked grant or disconnected invitation
makes coordination unavailable in that editor. It never creates a second local
writer. Reconnect to the same daemon and checkout with an owner invitation to
restore access. History sharing retains its separate connection and consent.

## Verify lifecycle and access

- Close and reopen VS Code. The saved invitation reconnects to the same host.
- Restart the compute daemon. Its host ID and attachment remain; the runtime ID
  changes. The editor retries a dropped connection automatically.
- On the compute machine, run
  `codex app-server idle revoke --grant-id ID`. The editor retains the host row
  and marks it unavailable. Status normally refreshes every ten seconds.
- Run **Idle: Disconnect Compute Host** to remove this editor's saved
  connection. Run `codex app-server idle stop` on the compute machine to stop
  hosting and remove its tunnel. Neither command terminates the Codex daemon.

Invitations have a bounded lifetime. An expired grant or relay credential needs
a new invitation from the owner. Wrong workspace, expired and revoked
invitations cannot fall back to local owner access. A saved host with missing
checkout directories reports unavailable.

## Automated live check

The following test creates its own temporary daemon and Dev Tunnel, uses the
extension's actual native runtime adapter, verifies reconnect and revocation,
transfers coordination, checks writes on the compute checkout and removes the
tunnel afterward. It also exercises a lost transfer acknowledgement, editor and
daemon restart, and rejection of an attachment-only grant. It needs authenticated
GitHub CLI access.
Run it on Linux; it uses a temporary Unix control socket and signals only the
daemon it starts.

```sh
IDLE_CODEX_BIN=/absolute/codex \
IDLE_RUNTIME_HOST_BIN=/absolute/idle-host \
IDLE_GITHUB_CLI=/absolute/gh \
  npm run test:compute:live
```

Both endpoints run as separate processes on the test machine and communicate
through the live relay service. For a two-machine check, follow the pairing
steps with VS Code and the daemon on different machines.
