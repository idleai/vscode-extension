# Native history actions

The TypeScript host binds VS Code documents and commands to
`idle-vscode-native::history`. The Rust adapter resolves records and content
through `editchain_engine::queries::ChainQueries`. It does not interpret rendered
history rows, shorten IDs, read the working tree, apply partial patches or run Git
to invent a missing snapshot.

## Installation and callers

Selection/coordination code installs one binding with
`host.history.connect(binding, provider?)`. The binding contains:

- `root`: an explicit checkout URI inside an open native workspace folder,
  including its remote authority when applicable.
- `repository`: app-core's `{ workspace_id, repository_id, chain }` selection.
- `chainDirectory`: the absolute current-chain directory on that host.
- `retainedDirectory`: an optional, separately selected retained input chain or
  migration archive. A directory containing only original segments supports raw
  records; content needs its own retained blobs.

The default provider lazily starts the packaged `idle-history-service`, passing
these locations once as process arguments. Requests carry logical bindings and
record references, never storage paths. An injected `HistoryProvider` may reuse
the owning engine connection; it must enforce the same contract and cancellation.
Bindings are independent of views. Their disposables release only the installed
generation. Repository replacement, account changes, configuration changes,
folder changes and shutdown invalidate outstanding operations and old documents.

The host effects and methods are:

| Entry point | Input | Result |
| --- | --- | --- |
| `history.open` / `host.history.open` | `HistoryRequest` | Opened preview URIs and companion exact byte URIs |
| `history.openQuery` / `host.history.openQuery` | `{ binding, query }`, with app-core's `QueryAction::Open` | `Opened` after the native editor action succeeds |
| `history.openWorkingFile` / `host.history.openWorking` | `{ binding, path, position? }` | Explicit live checkout file opened |

Commands `idle.history.openRecord`, `openOriginal`, `openFile` and `openDiff`
use the same request with their corresponding target. `idle.history.openWorkingFile`
uses the working-copy input. Commands require supplied references and are hidden
from the command palette. Workspace Trust is checked before and after async reads.

Working-copy paths must be relative, with no traversal, drive or URI syntax.
Real paths must remain inside the bound checkout, including through symlinks.
Optional positions use one-based Unicode scalar coordinates; the host converts
them to VS Code UTF-16 positions. A revision argument cannot invoke this path.

## Record and content contract

`HistoryRequest` contains `binding`, `source` (`current` by default or `retained`),
`record: { operation, hash }`, and `target`. Both ID and digest require 64 lowercase
hexadecimal digits. Each action refreshes the engine index for late blobs and
conflict retractions. The exact encoded record digest must match before any
content action proceeds.

| Target | Resolution |
| --- | --- |
| `Record` | `record_variants`, selecting the exact digest, including a requested quarantined variant |
| `Original` | The selected Original payload, or the single recorded `Operation.original` link; the returned document carries the actual Original record reference |
| `File` | The complete `FileAfter` snapshot |
| `Diff` | Complete `FileBase` and `FileAfter` snapshots, in that order, with recorded rename labels |
| `{ Content: { field, reference } }` | Exact engine field and matching complete external content reference, including declared length; `reference: null` selects inline content |

Engine fields and external references use their native Serde representation.
Available bytes use the engine's shared lossless text/binary JSON codec. This
preserves Unicode, BOMs, CR/LF, whitespace, NULs and invalid UTF-8. `Payload::Empty`
in schema-three content means unrecorded; an inline zero-length payload or a
verified empty blob is available empty content.

Missing records, digest mismatches, conflicts, unrecorded fields, missing blobs,
corrupt blobs and unresolvable addresses have separate error codes. No failure
is converted to an empty editor document. A diff requires both complete sides;
the stored `FileEdit` remains separately accessible through a content action.
Storage/index contention returns an error and can be retried; the packaged
service releases its derived index after each request.

Native framing uses the existing little-endian length-prefixed `{ id, body }`
transport. The service accepts requests up to 1 MiB and responses up to 64 MiB.
Oversized previews fail as `too_large`; they are never truncated.

## Aliases and retained inputs

A physically retained operation ID takes precedence over aliases. When a full
ID exists only as a migration alias, the action returns `migrated_alias` with
complete candidate record references. It does not apply the old digest to a new
representation, choose an ambiguous candidate, or substitute converted bytes.
The caller can explicitly select a new candidate, or use `source: retained` with
the original record reference and a separately installed retained directory.

An Original payload and a pre-conversion encoded record are different documents.
`Original` follows the recorded source link. `Record` in the retained namespace
opens the exact old encoding. No source location stored in an Original record is
opened as a local file.

## Document lifetime and byte fidelity

The read-only `idle-history:` filesystem exposes the unchanged byte buffer.
`idle-history-text:` previews decode UTF-8 strictly, preserving a recorded BOM and
avoiding workspace encoding preferences. Binary content uses
`idle-history-hex:` for a complete hexadecimal view with byte offsets; both diff
sides use hex if either is binary. The byte URI remains available in the action
result. VS Code controls text display and line-ending rendering; the byte
provider is the lossless source for inspection or export.

Document addresses contain a connection generation, complete request and side.
Reads resolve those references again through the engine; no FIFO eviction can
turn an open tab into a blank file. Detached, unknown or expired addresses fail.
Recorded path text supplies a sanitized display basename only. Writes, renames
and deletion are denied by the provider.

## Extraction and remaining assembly

This moves the responsibilities of EditChain's `JsonContentProvider`,
`DiffContentProvider`, `openDiffEditor` and raw-record command routing from
`extensions/vscode-editchain/src/extension.ts` into `extension/src/history/`,
with engine resolution in `crates/idle-vscode-native/src/history/`.
The old pretty-printed JSON and hunk-only documents are replaced by exact record
and snapshot reads. Missing snapshots cannot be presented as whole-file diffs.

The legacy host still serves its existing renderer and capture consumers.
f43 owns switching those consumers to these bindings and shared app-core/web-ui
actions, then removing the legacy provider registrations and handlers. No new
production fixture or implicit repository discovery is installed by f40.

The package also resolves the previously unhandled `Effect::Projection` and
`Effect::Resource` as unavailable in the bootstrap shell. Production projection,
resource and history view assembly remains with f43.

## Verification

Rust tests write real engine records and blobs, exercise schema conversion and
the retained migration archive, and cover conflicts, late blobs, corruption,
complete content references and exact encoded records. Host tests cover byte and
hex providers, multi-root/remote bindings, cancellation, invalid responses,
working-path containment and Unicode positions.

`scripts/smoke-package.cjs` extracts the VSIX and activates its bundled host.
`scripts/smoke-history.cjs` creates synthetic engine history with the
`history-fixture` example, then compares packaged service/provider bytes against
the input snapshots and encoded record, including empty and missing content.
The test checkout has no live file matching the historical filename.

Run `./scripts/lint.sh`, `npm test`, and `./scripts/check.sh`. The last command
includes packaging and the isolated VSIX checks.

Verified with EditChain `3c75cf0`, app-core `4b7c6d1` (`f26/resource-state`) and
web-ui `e81e72c` (`f32/session-ui`). The bootstrap's `Resource` response requires
the f26 interface; CI's sibling checkouts must include that commit before this
consumer change lands. Local lint returned `RESULT: PASS`; the full check exited
successfully with 189 host tests and the packaged history/capture checks.
