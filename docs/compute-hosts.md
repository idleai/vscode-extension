# Connect a Codex compute host

VS Code connects to the compute machine through Dev Tunnels. The daemon keeps
running when the editor closes. You can attach a workspace, inspect its status
and explicitly move workspace coordination to that daemon. With a runner
invitation, you can also submit agent work and reopen its results after the
editor closes.

## Install matching versions

Build `codex` from the `idle-base` branch of `idleai/codex-evo`. Build/install this
extension from `main` using the normal [setup instructions](../README.md#setup).
Its package includes native host 0.4.0 or a newer compatible release.

On the compute machine, download the matching platform bundle from the
[native host 0.4.0 release](https://github.com/idleai/host-tools/releases/tag/idle-coordination-v0.4.0)
and use its `idle-host` as the relay helper. A source build from host-tools `main`
also works. Native host 0.3.1 supports attachment and status only. The extension
checks the native host and daemon's capabilities before moving coordination.

If you previously set **Idle: Native Host Path** (`idle.native.hostPath`) on the
editor machine, clear it to use the packaged helper or point it at the updated
executable.

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

## Run an agent on the compute host

Runner support requires matching Codex and native helper builds. The native
helper must advertise `runtime.runners`; the released 0.4.0 helper does not
support runner commands. For this preview, use host-tools' `evo2/runner-client`
build on both machines and set **Idle: Native Host Path** on the editor machine
to that executable. Use the Codex runner branch paired with this extension.

1. Complete the workspace coordination transfer above. The current runner
   connection uses that same contributor and approved checkout.
2. Sign in to the desired model provider on the compute machine and configure
   the daemon's model using the normal Codex settings.
3. Issue a separate invitation with `--runner` in place of
   `--coordination-owner`, using a new private output file. The default runner
   grant permits reading and writing the compute checkout. Workspace agent
   rules can narrow that scope.
4. In VS Code, run **Idle: Connect Runner Host** and paste the invitation. Run
   **Idle: Start Runner** to submit a task. The **Idle Runners** output channel
   shows its output and thread ID.
5. Use **Idle: Open Runner** to select a saved runner or enter its thread ID,
   and **Idle: Send to Runner** to submit another task. **Idle: Review Runner
   Approval** displays any command waiting for a decision.

Runners execute on the selected daemon's local executor. Network access is
denied. The checkout's `.idle` and `.codex` directories, the chain directory and
the daemon's private state remain inaccessible to runner commands. Required
platform runtime files remain readable. The daemon's existing approval policy
still applies, and approval cannot expand the runner's saved permissions.

In `.idle/workspace/agent-rules.json`, keep the existing document and add a
`runners` object to narrow execution, for example:

```json
{
  "schema_version": 1,
  "runners": { "version": 1, "readRoots": ["."], "writeRoots": ["src"] }
}
```

Roots must name existing directories inside the checkout. An empty
`writeRoots` list makes checkout access read-only; `enabled: false` disables
runners. Changing rules or revoking a grant stops affected active work.
Reopen the runner to apply narrowed rules. A saved runner or fork cannot gain
broader access from a later invitation or rule change.

Closing VS Code or disconnecting its runner connection leaves admitted work
running. Pending approvals remain undecided. Use **Idle: Interrupt Runner** to
request interruption, or revoke its grant on the compute machine to stop
authorized access. A daemon restart retains saved history and scope; it does
not restart a terminated command automatically.

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

For the one-hour renewal and expiry check, append `-- --soak` to the npm command.
It closes the client for eleven minutes, checks that the daemon rereads its
management credential, reconnects across subsequent renewal cycles, waits for
the invitation to expire and restores the same coordinator with a fresh owner
invitation. The credential wrapper records timestamps only. This check uses
real time and the live relay service.

Both endpoints run as separate processes on the test machine and communicate
through the live relay service. For a two-machine check, follow the pairing
steps with VS Code and the daemon on different machines.

### Desktop acceptance on a separate machine

Push the tested extension commit to an `acceptance/compute/...` branch to opt
into the additional CI job. After normal package checks, that job installs the
VSIX in desktop VS Code on a GitHub-hosted machine and uploads a public
`compute-connection-request` artifact. Once that artifact is available, run this
on the compute machine using the workflow run ID:

```sh
IDLE_CODEX_BIN=/absolute/codex \
IDLE_RUNTIME_HOST_BIN=/absolute/idle-host \
IDLE_GITHUB_CLI=/absolute/gh \
  node scripts/smoke-compute-owner.cjs WORKFLOW_RUN_ID
```

The owner script creates a temporary daemon, checkout and one-hour grant. It
encrypts the invitation to a key generated on the test desktop and returns the
ciphertext through a temporary Git branch containing only that invitation. No account credential or
plaintext invitation enters CI logs or artifacts. The desktop moves
coordination, writes configuration on the compute machine, exits completely and
reopens using VS Code secret storage. The owner verifies the resulting compute
files, revokes the grant and removes the tunnel, temporary branch and local
state. The `compute-results` artifact records the desktop version and host IDs.

Branches named `acceptance/compute/evo2-...` also run the real model test. Supply
`IDLE_COMPUTE_RUNNER=1`, `IDLE_CODEX_AUTH_SOURCE` pointing to a private Codex
`auth.json`, and `IDLE_CODEX_RUNNER_CONFIG` pointing to a Codex configuration
file when starting the owner script. Those files are copied only into the
temporary compute daemon's private home. The model runs a command that spans
desktop exit and checks checkout writes, denied reads/writes, symlink escape,
network denial and excluded account environment variables. Reopening the
desktop must recover the completed result from native history.
