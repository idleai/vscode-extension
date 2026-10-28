# Activity implementation against the shipped original

The reference is the production Rust/WASM renderer and paged native service at
`editchain` commit `1e9b321fc668d81f8924df8113b2b3b7645ce5a6`. The earlier JavaScript
prototype is not the shipped UI. The investigation covered native projection,
task disclosure, graph planning, DOM construction, final CSS, input handling,
immutable document opening, and the associated native and renderer tests before
changing the current product.

## Implementation contract

| Area | Shipped behavior to reproduce | Current owner |
| --- | --- | --- |
| Table | 34 px rows; computed Graph, 88 px Activity, 180 px Tags, flexible Content, 160 px Date; responsive Tags/Date | web-ui |
| Content | One line of plain normalized text, semantic 16 px icon, optional compact tool title, full-summary tooltip | host-tools / web-ui |
| Task control | Entire `▸ N activities` button in Tags; original physical anchor and kind; separate item disclosure | app-core / web-ui |
| Mouse | Ordinary click selects; folded task body selects and expands; file click opens its exact diff; ordinary double-click opens JSON | app-core / web-ui / extension |
| Keyboard | Row focus independent from selection; roving row tab stop; Up/Down and Home/End move focus; Enter/Space follow row disclosure rules | web-ui |
| Pending controls | Preserve old rows; retain each toggle; busy control remains usable | app-core / web-ui |
| Details | Inline record and Git-file children belong to their physical parent, with no extra graph node | host-tools / app-core / web-ui |
| Groups | Native causal paths, original source/task incarnation and protected cuts; member counts exclude detail children | host-tools |
| Find | Navigate actual physical activities and expose matching folded members | host-tools / app-core / web-ui |
| Graph | Native lane and parent identities, old paint geometry and colors, endpoint labels | host-tools / web-ui |
| Opening | Full immutable record JSON and validated recorded or Git file descriptors | host-tools / extension |

Task and item disclosures are independent. An expanded task body does not fold
the task. Collapsing a group containing the selected child clears the hidden
selection rather than moving it to the summary. The summary annotates the newest
eligible physical member; it is never a new synthetic activity. Interleaved
activities remain visible when a task is expanded.

The original row focus returns to the physical row after disclosure. Enter on
the provider task button therefore expands it, and a second Enter can open the
ordinary anchor's JSON. Dates are UTC. Ordinary rows have no hover background;
selected rows use VS Code active-selection colors throughout their cells.

## Source map

All paths in this section are relative to the historical checkout above.

- `extensions/vscode-editchain/src/extension.ts:666` selects `OpenLivePaged`;
  `:1131` loads the Rust renderer and production stylesheet.
- `extensions/vscode-editchain/media/main.css:1112` begins the final table
  overrides; `:1452`, `:1737`, and `:1770` define chips, narrow layouts, and the
  task-count button.
- `crates/editchain-history-renderer/src/app/rows/chrome.rs` defines semantic
  labels, icons, content titles, and consequential outcome tags.
- `crates/editchain-history-renderer/src/app/rows/tasks.rs` substitutes the folded
  summary while retaining physical identity and the anchor's original content.
- `crates/editchain-history-renderer/src/shell/input.rs:219` and `:322` define
  mouse and keyboard behavior; `shell/mod.rs:253` defines selection/open order.
- `crates/editchain-history-renderer/src/app/dom.rs:1498` and `:1606` restore row
  focus and reconcile keyed row content.
- `crates/editchain-node/src/history/realtime/tasks/runs.rs` defines eligible
  causal paths; `tasks/metadata.rs` verifies lifecycle and prompt fields.
- `crates/editchain-node/src/history/realtime/disclosure.rs` and
  `disclosure/viewport.rs` separate manual, automatic, and Find disclosure.
- `crates/editchain-node/src/history/files.rs` validates exact file descriptors;
  `presentation.rs` supplies typed content and attached file/detail rows.
- `extensions/vscode-editchain/src/extension.ts:788` through `:1041` open immutable
  JSON, text diffs, and disconnected recorded hunks.

## Comparison corrections

The earlier image labeled as all 28 provider members contains 28 consecutive
rows, including an interleaved human edit. A complete capture must use actual
native group membership, continue through the final member, and retain every
interleaved row. Counts and row identities must be checked independently of the
number of cropped rows.

Copying `.git` to the frozen fixture changes the path-derived repository ID.
Sixteen recorded Git references then become unresolved even though their commit
objects exist. The old planner allocates lanes for those missing parents, while
the current planner does not. Recreating those bends or inferring cross-repository
aliases from equal commit hashes would copy a fixture artifact into the product.
Use the original repository as a read-only Git source and the isolated frozen
chain as the record source where both adapters permit it; verify HEAD and refs
before and after. Preserve the original frozen comparison separately.

## Implemented changes

The table now uses the original column dimensions, compact semantic icons,
one-line summaries, content headings, file names and directories, status tags,
task-count buttons, and UTC dates. Its graph uses the original 14.76 px lane
pitch, ten-color palette, 1.4 px rails, split-color quadratic bends, fixed nodes,
folded-task capsules, and endpoint captions. Native graph relationships and
source columns still determine the routes.

Selection, row focus, task disclosure, and item disclosure now have separate
state. Ordinary clicks select; double-clicks inspect JSON; file rows open their
recorded content. Arrow keys move focus without changing selection. Repeated
disclosure clicks retain their order while a request is pending. Find can expose
an individual member of a folded task; Escape clears Find and selection while
retaining the search draft. Manual task choices survive a binding refresh.

Expanded records and commits have inline children in the native paged result.
Children can span pages, retain their physical parent's scroll anchor, and do
not add graph nodes or inflate task counts. A commit-file child carries its
repository, complete commit and blob hashes, paths, modes, and status. The native
host checks the complete descriptor against that commit before returning either
side. The extension opens those immutable sides, handles binary results without
inventing text, and rejects stale or foreign replies.

The comparison also exposed two native data gaps. Recorded commit references
outside HEAD now seed the Git walk when they belong to the bound repository;
foreign repository references cannot add commits. Legacy file operations with
empty inline names now obtain their file names from the associated provider
record, human edit, or explicit file annotation. Neither change rewrites the
recorded operation or its identity.

The timeline protocol is version 3 and the generated native index is version 9.
The four repositories must be built together or released in dependency order:
host-tools, app-core, web-ui, then vscode-extension. The candidate resolves these
local producers with the existing product pipeline and includes the resulting
native executable and WebAssembly. It is a local Linux x64 package.

## Remaining differences

- The current toolbar and filters remain. Graph lane allocation retains the
  current source-column rules and the guard that keeps bends clear of unrelated
  nodes. Graph paint matches the old style, but every route is not identical.
- The old viewport-based automatic task disclosure and persistence across
  process restarts are not ported. Current live-group defaults and explicit
  choices during the running session remain in effect.
- Endpoint captions use recorded session labels or shortened IDs. Old nickname
  and model-chip enrichment is not fully reproduced.
- Some imported summaries retain the current native normalization. Files without
  complete recorded content still use the existing exact-record fallback;
  the old disconnected-hunk viewer is not reproduced.

## Validation

Validation uses the shipped original and the extracted candidate's actual
renderers and native services. Only the VS Code transport is adapted. Editor
commands and the content returned by their providers are recorded. Tracking and
live import are disabled; no comparison-only stylesheet changes the candidate.

The focused checks cover physical anchors, independent disclosure, rapid repeated
toggles, ordinary selection, exact opens, keyboard focus, interleaved members,
child pagination, recorded Git branches, and legacy file-name resolution.
Each modified repository runs its canonical `./scripts/check.sh`, which invokes
`./scripts/lint.sh`; the browser suite exercises the compiled Rust/WASM UI.

Three new public wire structs use the existing narrowly scoped
`#[expect(clippy::unsafe_derive_deserialize)]` pattern: `Presentation`, `Details`,
and `CommitFile`. The reason is that Facet reflection adds no safety invariants
to their deserialized fields. No lint levels or check entrypoints were weakened.

All four canonical check scripts exited 0. Their lint entrypoints each printed
exactly `RESULT: PASS`. This includes native and WebAssembly builds, the app-core
Swift and Kotlin binding checks, 47 native timeline tests, 108 web-ui unit tests,
and 330 extension tests. The compiled Activity browser suite passed all 9 cases.
The final VSIX also passed the packaged native and activation smoke tests.

Six matched captures contain 71 row comparisons, checked by raw operation or
commit identity, timestamp, order, and 34 px row geometry. The complete provider
capture includes all 28 native group members plus the interleaved human edit.
The final capture check also rejects any mounted file row with a blank file name.
The two stacks have different overall row totals, so captures align physical
identities independently instead of assuming equal offsets or counts.

The paired interaction run passed all 24 group actions. A further packaged
candidate run verified inline commit files, identical immutable before/after
text from both native services, independent keyboard focus, full commit JSON,
and native Find navigation and clearing. Closing the final comparison confirmed
that the source repository's HEAD and refs and both private copies of all 1,619
raw input files were unchanged.

The capture links below refer to local validation outputs. The recorded corpus,
screenshots, and packaged candidate are excluded from Git.

| Capture | Result |
| --- | --- |
| [Provider collapsed](../outputs/activity-original/same-rows/provider-collapsed.png) | 8 matching row pairs |
| [Provider expanded](../outputs/activity-original/same-rows/provider-revealed.png) | 10 matching row pairs |
| [All provider members](../outputs/activity-original/same-rows/provider-all-members.png) | 28 members and 1 interleaved row |
| [Provider minimized](../outputs/activity-original/same-rows/provider-minimized.png) | 8 matching row pairs |
| [Human task collapsed](../outputs/activity-original/same-rows/human-collapsed.png) | 7 matching row pairs |
| [Human task expanded](../outputs/activity-original/same-rows/human-revealed.png) | 9 matching row pairs |

## Local deliverables

- [Linux x64 candidate VSIX](../outputs/activity-original/candidate/idle-activity-original-linux-x64.vsix)
  with [size and SHA-256](../outputs/activity-original/candidate/artifact.json).
- [Source revisions and changed-file hashes](../outputs/activity-original/source-manifest.json)
  and per-repository patches under `outputs/activity-original/source-patches/`.
- [Canonical check results](../outputs/activity-original/local-build/validation.json),
  with the complete logs in the same directory.
- [Matched-row results](../outputs/activity-original/same-rows/summary.json).
- [Group interaction results](../outputs/activity-original/groups/summary.json)
  and the [provider disclosure animation](../outputs/activity-original/groups/provider-cycle.gif).
- [File opening and Find results](../outputs/activity-original/interactions/summary.json)
  and the [inline commit-file comparison](../outputs/activity-original/interactions/commit-files.png).

The candidate was built in four isolated worktrees under
`/mnt/hot/ambientlight/.codex/worktrees/activity-compare-20261025/`. The three
producer branches are `f43/activity-original`; the extension branch is
`f43/activity-comparison`. The packaged candidate is local and has not been
installed or published.

The exact resolved Cargo configurations and lockfiles are saved under
`outputs/activity-original/local-build/resolved/`, alongside the selected
dependency records and native archive. Temporary local dependency overrides and
target symlinks were removed from the worktrees after the checks. Rebuilding the
unreleased cross-repository changes requires those local producer selections;
ordinary builds using the currently published packages do not include this work.
