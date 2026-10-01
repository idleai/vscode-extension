# Editor capture (f39)

`extension/src/capture` observes VS Code on the file-owning host.
`idle-editor-capture` owns the editor wire contract, validation, conversion and
durable writer. `idle-vscode-native::capture` re-exports this boundary. The
`idle-editor-service` executable serves capture RPC independently of the
history service, peer process and webviews.

Capture starts for each enabled, trusted workspace folder during activation.
Resource-scoped `idle.tracking.*` settings and the folder's explicit
`idle.chainDirectory` select its policy and destination. Nested workspace
folders keep their own settings. Untitled buffers are captured only when one
workspace folder makes their destination unambiguous. Remote URIs must belong
to the same file-owning authority. Virtual filesystems are unsupported.

## Recorded contract

Operation schema **3**, raw editor observation schema **1**, portable JSONL
archive schema **1**, and converter **`idle.vscode.schema3.v1`** are separate
versions. Current raw observations explicitly declare UTF-16 offset/length
units, zero-based line/UTF-16-column positions and UTF-8 snapshot encoding.
Older raw archives without that declaration remain readable.

| Record | Identity and contents |
| --- | --- |
| Original | Full observation ID derived from recorder incarnation and source sequence; exact admitted JSON bytes, hash and unmodified native IDs. |
| Session | Logical editing session for the recorder incarnation; lifecycle and observed capture settings. |
| Author | Separate recorder and unsigned local contributor items. Optional account labels are display metadata, not an authenticated account binding. Git authors and host labels never supply an editor author. |
| File | Separate full observation and revision-item IDs. Snapshot/change/save/read actions reference the exact buffer revision. Changes retain both complete UTF-8 contents, an explicit byte replacement and ordered native UTF-16 edits. Saving is a separate event. |
| Note | Versioned Git context, capture gaps, editor observations and late input attribution. Attribution targets the earlier file observation IDs and revision items; it never rewrites a file's original author. |

All observation and item IDs are 256 bits. Buffer incarnation and version are
part of revision identity; matching content hashes do not merge distinct
revisions. Each change names its earlier revision as a logical cause and its
recorded source and Git context as operation parents. Some records have more
than two parents: consumers must use the engine's `Op::parent_ids()`.

Read observations retain disjoint visible ranges, their native coordinates,
UTF-8 byte ranges, duration and revision. Dwell is measured with a monotonic
clock, applies only to the active foreground editor, and is checked against
the recorded session policy. These are reading indicators, not claims about
comprehension. Detailed editor input metadata and conservative keyboard
fallbacks produce targeted input notes; unsupported edits remain unattributed.

Snapshots include unsaved text. Configured size limits, the existing binary
heuristic, missing baselines, capacity pauses and configuration changes retain
explicit gaps. Pause/resume starts a new recorder and captures the current
unsaved baseline. Intermediate changes while tracking is off are unobserved.

## Durability and raw archives

The host freezes each admitted event once and journals it locally before native
delivery. Journal files carry monotonic batch order, so a randomly named new
recorder cannot overtake recovered work. A batch stays on disk until the service
returns its exact ordered acknowledgement and operation schema 3. Lost replies,
service restarts, partial batches and writer contention retry the same bytes.

The native writer validates source predecessors, full revision contents and
UTF-16 replay. It uses the engine's EC03 append log and blob storage, and returns
an acknowledgement after durable writes. Missing source history, conflicting
identities and unavailable revisions fail explicitly. Conflicting source bytes
remain stored and quarantined. Duplicate delivery can repair missing blobs.
Lookups rebuild from recorded source sequences and immutable records; hash order
does not establish progress or chronology.

`idle.tracking.jsonl.enabled` additionally records the admitted event's exact
JSON slice in `editchain-human-history` lines. The archive is independent of
delivery retries, retains full snapshots and original workspace paths, and
does not recursively capture its own files, including directory aliases.
Destinations are allocated once per activation and drained on shutdown. Archive
failures are reported; they do not claim that later events were archived.

`CaptureWriter::record_archive_line` replays these lines into an explicitly
chosen chain. The same event slice yields the same Original and converted
identities, including when archive replay overlaps live capture. Use this
editor-owned adapter for new archives. The old EditChain editor importer remains
a legacy consumer until its compatibility wiring is switched.

Existing EC02 chains are never silently converted. The engine refuses an EC02
append; pending capture remains in the outbox. Configure an explicitly migrated
EC03 copy to continue recording. The host does not change sharing rules or
perform migration automatically.

## Extraction and compatibility ownership

| Source in EditChain | Destination |
| --- | --- |
| `extensions/vscode-editchain/src/editor*.ts` | `extension/src/capture/editor*.ts` |
| `humanWork.ts`, `humanIdentity.ts`, `humanAccount.ts`, `historyArchive.ts` capture responsibilities | `extension/src/capture/index.ts`, `humanIdentity.ts`, `historyArchive.ts`, with existing host credentials/process adapters |
| `editchain-protocol::editor` and its UTF-16 replay validation | `idle-editor-capture::wire` |
| `editchain-node::editor::context` | `idle-editor-capture::observe_context` |
| `editchain-node::editor` admission and normalization responsibilities | `idle-editor-capture::CaptureWriter` and schema-three `convert` modules |

Implementation changes are confined to `vscode-extension`. The EditChain
checkout remains unchanged and its legacy extension, editor protocol and writer
remain executable for existing consumers. The new extension has no dependency
on `editchain-node` or `editchain-protocol`. f43 owns switching the remaining
legacy host consumers and retiring their old capture paths alongside f40's
native-history switch. Keep the old importer available for old archives until
its callers use the editor-owned replay adapter.

f39 owns the new capture crate, capture executable, manifest settings,
activation/shutdown hooks and capture packaging script. The only webview change
is the explicit unavailable response required by the current sibling
`app-core::Effect::Projection` interface. That interface is present in the local
f25 work; publish that dependency before building this combination in CI, which
checks out sibling `main` branches. Production projection connections remain
with f43.

## Verification

Run `npm test` for host lifecycle, settings, trust, multi-root and remote
isolation, input attribution, exposure, archive and outbox regressions. Rust
tests exercise schema-three contents, full identities, Unicode units, Git
context references, targeted notes, source conflicts, exact archive replay,
blob repair and reordered/duplicate deliveries.

`./scripts/lint.sh` is the canonical Rust gate. `./scripts/check.sh` additionally
builds and packages the extension, extracts the VSIX, and runs its actual native
capture executable against a temporary Git checkout. The native smoke covers
unsaved Unicode, Git context, raw archives and a lost acknowledgement followed
by process restart and ordered replay. Editor events in automated tests use the
VS Code API harness; they do not claim a desktop or second-machine UI run.
