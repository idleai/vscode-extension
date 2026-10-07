# Extension assembly (f43)

The Idle container contributes six native `TreeView`s: Workspace, Users,
Sessions, Projections, Compute hosts and Model providers. Activity is a
`WebviewView` containing the Rust graph and a footer with standalone Settings and
Agent Rules links. The links have no section headers or disclosure controls;
they stay below the scrollable graph and share the Activity view's visibility.
VS Code owns the section headers,
dividers, resizing, ordering and collapse state, plus the native lists' rows,
icons, tooltips, selection, keyboard navigation, menus and virtualized scrolling.
The tree registration follows Microsoft's [Containers implementation](https://github.com/microsoft/vscode-containers/blob/main/extensions/vscode-containers/src/tree/registerTrees.ts).
Users, Projections, Compute hosts and Model providers start collapsed; the workbench retains
subsequent layout changes. The Activity graph fills its allocated view body.

`NativeSidebar` in the Rust crate owns a headless app-core runtime and projects
its typed view model into native tree records. The TypeScript adapter maps these
records to `TreeItem`s and executes allowlisted host effects. It owns no duplicate
domain model. Stable row IDs retain native selection across updates and renames;
unchanged snapshots do not reset scrolling. Native filter actions search loaded
names and descriptions. Data fetching and completeness remain Rust concerns;
native row virtualization does not imply server-side pagination.

All surfaces share an explicit workspace/repository/chain selection. On first use,
the active editor's folder is selected, or the sole folder in a single-folder
window. A multi-root window without an active folder waits for a choice. A valid
saved choice takes priority; removed or reconfigured bindings fall back to the
current folder. The host saves that binding in workspace storage and replays the latest choice after each
`host.ready`, including when VS Code recreates a hidden document. Rust waits for a
fresh directory and checks all three binding fields before adopting the selection.
The six trees share one extension-lifetime Rust runtime; collapsing trees or
closing Activity does not stop their updates. Activity and detail documents keep
their own scoped reads. Capture, bindings and native processes also belong to the
extension lifetime.

Row selections open the detail editor with the same binding, destination and
selected item keys. Rust waits for the matching domain data before applying
session or resource selections. Recorded sessions retain their full logical IDs
and open the matching recorded history; their rows make no execution claim.
A later user choice retires pending navigation. Old native row actions are rejected
after a binding change or context reset.
The native **Open Detail View** toolbar action opens its view's destination.
Workspace's secondary menu exposes Settings and Agent Rules. The native refresh
action refreshes the corresponding Rust directory. Repository inspection stays
in the detail editor.

Native trees use the workbench's actual stylesheet and product icon theme.
They need no copied row CSS or bundled icon font. The workbench injects theme
variables into the custom Activity and detail webviews; its stylesheet cannot
cascade across their iframes. [vscode-sidebar.css](../static/vscode-sidebar.css)
sizes the custom Activity body and its footer links. Their icons use the packaged
[Codicon font](https://github.com/microsoft/vscode-codicons), with its license;
other hosts retain the shared SVG fallback.
Shell protocol 14 includes the shared repository state and exact recorded-session
selections.

`host.ready` negotiates installed actions before the first workspace request.
Every runtime gives effects non-reused transport identities. Context changes immediately
clear the old view and capabilities, retire pending continuations and negotiate
again. Old and duplicate replies cannot populate the new view. Malformed results,
failed sends and request timeouts become visible failures. Closing a document
removes its listeners, timers and pending reads. A repository reader with no remaining waiters stops; capture and collection keep running.

## Local workspace coordination

Each native folder has an explicit workspace/repository/chain binding. The host
resolves `idle.chainDirectory` against that folder. Stable local aliases contain
no storage paths and never select another folder as a fallback.

The f18 coordinator inside `idle-host` supplies workspace membership,
resource directories, conditional settings/rules writes and audience-scoped recovery cursors.
The host installs its binding over the private pipe and retains state under extension global storage.
A persisted random contributor identity identifies the local VS Code profile;
its authority is the trusted local process connection. It is displayed as
**You (local)** and is independent of GitHub sign-in, peer device enrollment and
runtime identities. No bearer token enters the webview or coordinator configuration.
The metadata store has one process owner; another process using the same store
is reported as unavailable.

Metadata and sharing use `CoordinationProcess` to own their separate channels
in the shared native host, with startup checks and awaited shutdown. Their installations remain scoped
to their existing storage directories and contributor/account identities;
sharing supplies its own credential callback and explicit stop/suspend command.

The host accepts bounded snapshot, peer activity and catch-up reads and
configuration writes bound to its persisted local contributor. Other mutations
are unavailable through this view adapter.
It publishes expiring local peer activity itself, including an active file only when
it is within the selected folder. Account, folder or configuration changes retire
the corresponding channels and pending reads. Native restart reopens the saved
metadata. A closed view does not delete it.

Coordinator payloads cross the JavaScript bridge as exact JSON text. Rust converts
them using the shared protocol and app-core adapters, preserving revisions and
cursor positions above JavaScript's integer limit. Recovery checks the audience,
workspace, stream and increasing positions before reconciling. Empty catch-up
responses keep a bounded watch pending; an expired cursor triggers a fresh join
and replacement reads. Interrupted transport uses app-core's retry state.

## History and projections

`app.history` uses the history service inside `idle-host` and app-core's engine
adapter. Native record, Original, file and diff actions retain exact record
identities. Every read rechecks its installed binding, cancellation and Workspace
Trust. A missing chain is unavailable. Refreshes preserve current selection and
disclosure when those records still exist.

`app.projection` reads the same bound chain through app-core's projection engine
adapter. Recorded Activity has source references, bounded reads and explicit gaps.
The repository service inside `idle-host` supplies Tasks from open GitHub issues/PRs,
Errors from failed HEAD checks/runs, and Triage/human input from explicit labels
or requested reviewers. Exact stored response hashes are checked before rows are
admitted. Missing or changed sources, including missing or corrupt Original
bytes, remove affected rows with partial coverage;
a repository failure leaves local Activity readable. Source-page buttons use the
host external-link capability. An unavailable source never becomes a zero total.
Manual projection refresh revalidates GitHub sources, including when a recent
automatic read is cached or in progress. Background history changes keep their
normal source refresh bounds.

Collection and peer receipts publish scoped `history.changed` events. The Rust
runtime refreshes history and derived projections only for its current binding.
These local history notifications remain separate from the coordinator's durable
metadata cursor. Capture, collection, sharing and f42 author/exposure decorations
continue while views are closed.

Active Codex rollouts are append logs. Replacement, truncation and same-size
changes trigger a strict replay into a new source generation. A larger in-place
rewrite is checked on collector restart; normal live polls read appended bytes.
Imports checkpoint source positions after durable writes.

## Shared product surfaces

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
Edits made while draft storage is loading retain their text and recover any
original unresolved save. New saves wait until that request is resolved.

The repository overview resolves the selected checkout, branch, HEAD, worktree
status and sanitized remote. Initial reads return local Git details, recorded
sessions and the Activity projection before waiting for GitHub. The sidebar
graph already reads local history independently. Rust then requests complete
replacements, sharing remote work between repository and projection reads.
Remote categories keep unknown totals while loading. The native host advertises `repository.local`
before the adapter uses this optional operation; older hosts keep the existing
read protocol. Local and complete reads retain independent cancellation and the
same binding checks. Explicit refresh still revalidates GitHub. Unavailable
recorded-session reads receive up to three bounded retries for brief index
contention, reusing the native GitHub cache. Persistent failures retain their
source report.
Users separates local membership and online status
from Git authors, GitHub contributors and accessible collaborators. Recorded sessions keep
full logical IDs, recorded labels and exact source records. Selection is retained
per contributor, binding and surface; it survives view and host restart. Recorded
history stays visible when the selection is cleared. A delayed repository read
may restore the saved session preference without filtering an open Activity view.
Native reads share in-flight work, cancel each waiter independently and discard account
caches on replacement. Automatic updates reuse GitHub data for up to 60 seconds
with its original check time; explicit refresh revalidates it. Git reads work
offline and never fetch. See the [shared reader contract](https://github.com/idleai/host-tools/blob/main/docs/repository.md).
Managed providers and new live runtime implementations are deferred.

Session components have unavailable actions until an execution provider supplies
real capabilities and explicit session-to-history mappings. Directory membership
or a controller lease cannot establish a running session. Creation, input,
compute and model actions remain disabled; f17's live running-session lifetime
acceptance is still required. Runtime fixtures continue to verify both workspace
modes. Those later runtime tasks are outside standalone f43 acceptance.

Existing peer sharing commands retain their established runtime and saved consent.
The local coordinator does not start discovery, resume sharing or migrate peer
identities automatically.

## Assets and checks

The same Rust crate builds Node bindings under `dist/native` for the headless tree
runtime and browser bindings under `dist/pkg` for custom content. Browser mounting
is explicit, so loading Rust in the extension host does not access a DOM.
The build bundles styles for the custom Activity and detail components.
VS Code CSS variables update the shared webview theme.
The CSP permits graph coordinates while restricting scripts and style elements
to packaged assets.

The VSIX includes `idle-host` and `codex-session-exporter` for the build host's
OS/architecture. Installed copies resolve the configured absolute host or its
packaged binary. Build a platform-specific VSIX for each destination host.

[CI](../.github/workflows/ci.yml) selects the latest compatible Cargo packages
and native bundles once per run. See [packaging and releases](packaging.md) for
dependency selection and checking unpublished producer/consumer changes.

Run `./scripts/check.sh` for the canonical Rust checks, host tests, packaging and
native VSIX checks. Then run `test:webview` and `test:assembly` with `CHROME_BIN`
set to a Chrome executable. They use isolated browser profiles, synthetic
workspaces and packaged native tools. The assembly check covers navigation,
compact Activity, projection availability, multiple folders, exact previews,
recorded updates, host theme changes, Git authors, recorded-session selection
recovery, projection source URLs, exact stored Originals, conditional saves and
document reconnection. Regression checks also cover clearing the session filter,
late selection restoration, manual source refresh and edits during save recovery.

Run `VSCODE_BIN=/absolute/path/to/code npm run test:vscode` on Linux with
`xvfb-run` available. This installs the VSIX into a disposable extension directory,
starts a separate desktop VS Code profile and checks native metadata, Git and
recorded sessions, exact record/file/diff opens, author/exposure reads and capture
across view closure. A second launch verifies the saved session selection and
exact unfinished settings draft. The normal development driver retains VS Code
profile storage; extension-test mode would replace mementos with memory storage.
Profile, extensions and shared storage all use temporary directories. CI runs this check
with VS Code 1.140.0.

Run `VSCODE_BIN=/absolute/path/to/code CONTAINERS_EXTENSION=/absolute/path/to/ms-azuretools.vscode-containers-version npm run test:vscode:sidebar`
to compare the installed VSIX against Containers in a separate desktop profile.
This uses Puppeteer only to inspect the isolated Electron test process. It checks
seven native pane headers and their dividers, six native trees, row geometry,
shared selection across two folders, reopened Activity, exact recorded-session
detail routing, standalone Settings and Agent Rules links, keyboard navigation and disclosure in modern dark, modern light,
compact and classic layouts. A 1,202-row directory checks native list
virtualization, scrolling to the final row, filtering and clearing the filter. It also drags a native divider, checks layout persistence, and
checks live changes to header capitalization. Full
workbench captures, sidebar captures, measured values and a comparison page go
to `outputs/sidebar-vscode/` (or `IDLE_SIDEBAR_OUTPUT`). Docker resources are read
by Containers; the test does not start or stop them.

## Application ownership

The extension owns editor recording, platform events, credentials, trust checks
and service lifetime. Host-tools owns imports, source discovery and collection,
portable peer coordination and shared protocol/history contracts. App-core owns
semantic state, effects and view models. Web-ui owns shared rendering. EditChain
contains storage, schemas, indexes, queries, replication and engine tooling.

The old extension, native viewer service, renderer and compatibility projection/
protocol packages remain retired. Installed development collectors are outside
this change; there is no settings, identity or outbox handoff from an old extension.
