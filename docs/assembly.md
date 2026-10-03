# Extension assembly (f43)

The sidebar mounts f34's shared `WorkspaceNavigation` through
`web_ui::assembly::WorkspaceSurface`, over a persistent `app_core::Core`.
Workspace, Users, Sessions, Projections, Compute hosts, Model providers and compact
Activity stay in that order, followed by Settings and Agent Rules. Selecting
Activity opens the full history inspector; selecting Projections mounts f33's
panels. The detail tab exposes the same complete set of destinations. Each document
has separate selection and presentation state. Capture, bindings and native
processes belong to the extension lifetime.

`host.ready` negotiates installed actions before the first workspace request.
Every effect has a document-local transport identity. Context changes immediately
clear the old view and capabilities, retire pending continuations and negotiate
again. Old and duplicate replies cannot populate the new view. Malformed results,
failed sends and request timeouts become visible failures. Closing a document
removes its listeners, timers and pending reads without stopping native services.

## Local workspace coordination

Each native folder has an explicit workspace/repository/chain binding. The host
resolves `idle.chainDirectory` against that folder. Stable local aliases contain
no storage paths and never select another folder as a fallback.

The packaged f18 `idle-coordination` process supplies workspace membership,
resource directories, conditional settings/rules writes and audience-scoped recovery cursors.
The host creates a private startup configuration under extension global storage.
A persisted random contributor identity identifies the local VS Code profile;
its authority is the trusted local process connection. It is displayed as
**You (local)** and is independent of GitHub sign-in, peer device enrollment and
runtime identities. No bearer token enters the webview or coordinator configuration.
The metadata store has one process owner; another process using the same store
is reported as unavailable.

The host accepts bounded snapshot, presence and catch-up reads and configuration
writes bound to its persisted local contributor. Other mutations are unavailable
through this view adapter.
It publishes expiring local presence itself, including an active file only when
it is within the selected folder. Account, folder or configuration changes retire
the corresponding processes and pending reads. Native restart reopens the saved
metadata. A closed view does not delete it.

Coordinator payloads cross the JavaScript bridge as exact JSON text. Rust converts
them using the shared protocol and app-core adapters, preserving revisions and
cursor positions above JavaScript's integer limit. Recovery checks the audience,
workspace, stream and increasing positions before reconciling. Empty catch-up
responses keep a bounded watch pending; an expired cursor triggers a fresh join
and replacement reads. Interrupted transport uses app-core's retry state.

## History and projections

`app.history` uses the packaged `idle-history-service` and app-core's engine
adapter. Native record, Original, file and diff actions retain exact record
identities. Every read rechecks its installed binding, cancellation and Workspace
Trust. A missing chain is unavailable. Refreshes preserve current selection and
disclosure when those records still exist.

`app.projection` reads the same bound chain through app-core's projection engine
adapter. Recorded Activity has source references, bounded reads and explicit gaps.
Task, error, triage and human-input projections are explicitly unavailable while
no controller supplies them; an absent provider does not become a zero total.

Collection and peer receipts publish scoped `history.changed` events. The Rust
runtime refreshes history and derived projections only for its current binding.
These local history notifications remain separate from the coordinator's durable
metadata cursor. Capture, collection, sharing and f42 author/exposure decorations
continue while views are closed.

Active Codex rollouts are append logs. Replacement, truncation and same-size
changes trigger a strict replay into a new source generation. A larger in-place
rewrite is checked on collector restart; normal live polls read appended bytes.
Imports checkpoint source positions after durable writes.

## Remaining integrations

The shared f35 resource screens display actual publication owners, health,
provider-qualified models, controller leases and runtime progress. Compute,
model selection and installation controls use the supplied capability/grant
results. This standalone metadata connection supplies no execution capabilities.

The f36 Settings and Agent Rules forms load and save independently. Only an active
owner/admin can edit; the native authority rechecks every conditional write.
Each surface retains private drafts by repository binding and contributor.
Before forwarding a save, the host durably records its draft, unchanged request
ID, deadline, revision and complete JSON command. Reopening recovers uncertain
saves without automatic resubmission. Conflicts retain the original draft and
require explicit review of the current saved revision. Unknown fields and exact
64-bit revisions survive the JavaScript boundary.

Git/GitHub data and recorded-session directories are the remaining standalone
assembly work. Managed providers and new live runtime implementations are deferred.

Session components have unavailable actions until an execution provider supplies
real capabilities and explicit session-to-history mappings. Directory membership
or a controller lease cannot establish a running session. Creation, input,
compute and model actions remain disabled; f17's live running-session lifetime
acceptance is still required. Runtime fixtures continue to verify both workspace
modes. The broader f43 feature remains open.

Existing peer sharing commands retain their established runtime and saved consent.
The local coordinator does not start discovery, resume sharing or migrate peer
identities automatically.

## Assets and checks

The build bundles theme, navigation, projection, history, details, session,
configuration and resource styles with the application WASM. VS Code CSS variables update the shared theme.
The CSP permits graph coordinates while restricting scripts and style elements
to packaged assets.

The VSIX includes `idle-editor-service`, `idle-history-service`,
`idle-history-collector`, `codex-session-exporter`, `editchain-peer` and
`idle-coordination` for the build host's OS/architecture. Installed copies resolve
configured absolute executables or packaged tools; sibling source checkouts are
build inputs only. Build a platform-specific VSIX for each destination host.

[CI](../.github/workflows/ci.yml) pins the paired source revisions:

| Repository | Revision |
| --- | --- |
| app-core | `1cda8c9bff6ae21aabb0087f079666543a57b5db` |
| web-ui | `bdb581c39f95e258209fa23aba943866a7c4a6a4` |
| host-tools | `eba843a421a11769173d62117250aff5a7d89951` |
| EditChain | `45b94c95a2cb185a59e58cf0763f589c666ab1e6` |
| Codex exporter | `903d7f1c62c621cf1f925362ac88893ec1f36b07` |

Run `./scripts/check.sh` for the canonical Rust checks, host tests, packaging and
native VSIX checks. Then run `test:webview` and `test:assembly` with `CHROME_BIN`
set to a Chrome executable. They use isolated browser profiles, synthetic
workspaces and packaged native tools. The assembly check covers navigation,
compact Activity, projection availability, multiple folders, exact previews,
recorded updates, host theme changes and document reconnection.

Run `VSCODE_BIN=/absolute/path/to/code npm run test:vscode` on Linux with
`xvfb-run` available. This installs the VSIX into a disposable extension directory,
starts a separate desktop VS Code profile and checks native metadata, exact
record/file/diff opens, author/exposure reads and capture across view closure and
reopening. It does not attach to an existing editor profile. CI runs this check
with VS Code 1.140.0.

## Application ownership

The extension owns editor recording, platform events, credentials, trust checks
and service lifetime. Host-tools owns imports, source discovery and collection,
portable peer coordination and shared protocol/history contracts. App-core owns
semantic state, effects and view models. Web-ui owns shared rendering. EditChain
contains storage, schemas, indexes, queries, replication and engine tooling.

The old extension, native viewer service, renderer and compatibility projection/
protocol packages remain retired. Installed development collectors are outside
this change; there is no settings, identity or outbox handoff from an old extension.
