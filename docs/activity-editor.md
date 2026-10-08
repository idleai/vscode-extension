# Activity history in the editor

Run **Idle: Open Activity History** (`idle.activity.openDetail`) or select a row
in the Activity sidebar. The full editor displays a continuous 34-pixel table
with Graph, Activity, Tags, Content and Date columns. The sidebar uses a distinct
recent-window composition with the same native rows and routing.

Clicking an editor row opens a normal VS Code preview: the recorded diff for a
file change, the recorded file for a read/open event, or formatted operation JSON
for other recorded activities. Live Git commits open their immutable commit and
patch. Missing file content opens the exact operation JSON with
an explanation. Group headers open their representative operation. Disclosure
only expands or folds a group. Enter activates; arrow keys navigate. Native
preview requests are cancelled when superseded, and an older result cannot
replace the latest selection. Existing binary and encoded-record actions retain
their exact bytes.

Find navigates through native indexed matches, temporarily opening matching
groups and seeking beyond loaded pages. The editor retains scroll anchors,
manual disclosure choices and readable rows during fetch failures. The graph
column fits visible lanes automatically; View options contains filtering,
resizing, pan and lane zoom. Descriptions preserve Markdown code and emphasis,
and dates use UTC. Theme changes use the
workbench's tokens.

Graph turns are smooth cubic curves that meet the vertical rails without square
corners or leftover stubs. Branch colors continue through forks and joins. Active
source columns stay reserved until a recorded end, keeping nested children and
independent streams separate. Passing connections clear unrelated dots, and
continuation markers account for the full node radius at a clipped edge.

Mini selection transfers the workspace binding, occurrence identity, exact
record hash and current/retained source through `views.openDetail`. Rust waits
for the bound chain and its initial subscription reconciliation, seeks the
occurrence and verifies the returned address.
The two documents keep independent viewport state. Selecting a mini row reveals
the Activity editor; activating that editor row opens its native document.

## Compatible packages

| Owner | Minimum version for this implementation |
| --- | --- |
| EditChain crates and native bundle | 0.1.6 |
| `history-geometry` | 0.2.0 |
| Host-tools crates and native bundle | 0.3.0 |
| `app-core` | 0.2.0 |
| `web-ui` | 0.3.0 |
| `idle-vscode-webview` | 0.2.0 |

The host negotiates timeline version 2 and the operation JSON action before the
first timeline request. An older host returns an update instruction. Derived
checkpoints are disposable; rolling back the UI or rebuilding a checkpoint does
not alter recorded operations.

Release dependencies in the order above, with geometry preceding host-tools.
Keep geometry's producer release separate from web-ui's later consumer update,
so each release commit resolves published dependencies. The full web-ui update
follows the host-tools and app-core releases.
Normal builds resolve published versions. Unpublished paired changes are checked
with temporary registry overrides and locally built native bundles through the
[unpublished integration procedure](packaging.md#unpublished-integration).
Declared minimum versions belong in normal manifests; temporary overrides and
candidate lockfiles do not.

```sh
python3 /path/to/memos/scripts/check-integration.py \
  --producer /path/to/editchain \
  --producer /path/to/web-ui \
  --producer /path/to/host-tools \
  --producer /path/to/app-core \
  --consumer /path/to/vscode-extension \
  --output /path/to/candidate-artifacts
CHROME_BIN=/path/to/chrome node scripts/smoke-assembly.mjs idle.vsix
VSCODE_BIN=/path/to/code node scripts/smoke-vscode.cjs idle.vsix
```

The integration helper builds compatible native candidates, retains their
checksums and runs the canonical consumer checks, packaging and native smoke
checks. It restores dependency files on success or failure. The assembly check
uses the packaged WASM and native host in an isolated Chromium profile. The
installed check uses a disposable VS Code profile and verifies restart recovery.

Native structural fixtures cover provider capture/replay, ten siblings and
nested joins, group boundaries, deep paging, late parents/content/conflicts,
recorded identity and repository-qualified Git attachments. The shared UI suite
checks editor activation, Find, disclosure, dense routing, narrow widths, themes,
scroll anchors and mini handoff.

## Comparison with the shipped Activity view

The galleries, VSIX files and full logs under `outputs/` are local review
artifacts and are not tracked in Git. The figures below identify which build
each recorded check exercised. Draft branch checks and release order are
tracked in the linked cross-repository PRs.

The [paired capture gallery](../outputs/activity-parity-final/index.html) and
[review VSIX](../outputs/activity-parity-final/idle-activity-parity.vsix) contain
this comparison. The [validation record](../outputs/activity-parity-final/validation.json)
links its repository checks, packaged browser checks and installed VS Code run.

The [collapsed task routing review](../outputs/activity-routing-final/index.html)
contains the newer VSIX. It fixes disconnected lines between interleaved tasks
and checks every group disclosure, mixed expansion choices and page boundaries.
This correction uses the existing index without rebuilding it.

The comparison uses the shipped `1e9b321` build and the same frozen workspace
history and Git HEAD, at 1978 × 1248 pixels. The new projection matches all 799
logical activity identities, their complete order and visible parent connections.
Both builds show 224 default rows, 69 task groups, 34 Git commits and six lanes.
Task membership, captions and displayed record timestamps match exactly. All 28
failed results remain visible, and all nine human edit groups retain native diff
destinations. Command outputs and tool results retain the recorded content.

Lane allocation uses source continuity, so 125 default nodes occupy a different
column from the old bootstrap layout. The current workspace selector and View
options menu also remain. Git activation opens an immutable commit/patch document;
the earlier inline Git file expansion is a different interaction.

The semantic index revision rebuilds older derived checkpoints. On this copied
history, construction took 153.8 seconds across 38 resumable requests, followed by
an 84.3-ms latest-window read. These are local comparison timings without the
reference container limits. The larger performance measurements below describe
their linked earlier builds, not this semantic index revision.

## Graph correction review

The updated [review VSIX](../outputs/activity-metro-review/idle-activity-metro.vsix)
and [visual gallery](../outputs/activity-metro-review/index.html) include the graph
correction. Seven small native recordings cover a single chain, parent and child,
fork and join, two children, a nested child, independent streams, and a passing
connection. Both editor and mini are checked for expected columns, smooth curve
tangents, matching row seams, branch colors, and clearance around unrelated dots.
The browser suite also checks a node centered exactly on the graph edge.

Existing derived timelines upgrade their routes and task groups in batches of
500 records. The previous complete snapshot stays readable, and preparation can
be cancelled and restarted. This upgrade does not rewrite recorded operations.

On 1,000,023 records and 100 branches, the route upgrade and task-group preparation
took 40 min 1 s with the four-CPU, 8-GiB reference limits. The first measurements
after that upgrade were 57.2 ms for latest windows and 194.0 ms for seeks at p95.
A subsequent run of the final native build, using 1,000,028 records and warmer
seek pages, measured 49.8 ms and 63.8 ms. Each run measured 50 windows and 50 seeks.
The retained derived directory grew to approximately 146 GiB; rebuilding time
and retained page storage remain substantial costs.

The packaged editor displayed the million-record timeline in 229.9 ms p95 across
five warm samples after one warm-up, under the same limits. Opening during the
initial workspace reads took 1.43 s. Find returned the exact deep-history match
in 1.06 s. The whole reference container peaked at 1.45 GiB.

One earlier startup attempt failed to read the bound history source during
simultaneous workspace reads, after the existing retries were exhausted. The
unchanged rerun passed; this intermittent startup issue remains unresolved. Its
request and response log is retained with the review results.

The [native results](../outputs/activity-metro-review/native-performance.json)
retain both runs and their methods. The [validation record](../outputs/activity-metro-review/validation.json)
links the repository checks and packaged verification for this review.

## Baseline scale results

The initial implementation's review artifacts are in `outputs/activity-editor-final/`. Native
measurements use 100 concurrent branches, 200-row windows, 50 warm window reads
and 50 seeks distributed through the recording. The reference container has a
four-CPU quota, CPU affinity 0–3, an 8-GiB memory limit and no swap. The underlying
processor is an AMD Ryzen Threadripper PRO 7985WX.

| Recorded operations | Window p95 | Seek p95 | Cold construction | Peak process memory |
| --- | --- | --- | --- | --- |
| 10,000 | 32.3 ms | 40.0 ms | 22.5 s | 53.9 MiB |
| 100,000 | 42.2 ms | 51.5 ms | 6 min 18 s | 446.8 MiB |
| 1,000,018 | 53.6 ms | 179.8 ms | See construction method below | 653.4 MiB during warm measurements |

All three sizes meet the 200-ms warm query target. The million-record window
contains approximately 353 KiB of serialized summaries and routing. Five steady
appends at each size took 5.1, 3.2 and 5.5 ms p95 to record, followed by 151, 235
and 368 ms p95 to publish and read the updated timeline. Writer startup is
measured separately: 131 ms, 1.3 s and 7.1 s. Ordinary timeline updates use
accepted changes and affected graph paths; window reads use rank/select and
shared routing-prefix reads.

The original million-record construction took 85 min 42 s and peaked at
4.38 GiB. That run preceded the compact read-page optimization and used CPU
affinity plus an 8-GiB process address-space limit. Preparing the compact pages
from its completed checkpoint took a further 8 min 1 s. Final warm measurements
use the capped container described above. The 10,000 and 100,000 cold runs use
the final read-page implementation; a fresh million-record cold run of that
implementation was not repeated. The retained million-record derived directory
occupies approximately 105 GiB after construction and upgrades. Construction
time and derived disk usage remain substantial costs.

The [native results](../outputs/activity-editor-final/native-performance.json)
include exact timings, request sizes, memory readings and links to the complete
logs. `activity-benchmark --warm` reopens an existing corpus; its count argument
must match the `activity-benchmark-count` file because each measurement appends
five records. The packaged assembly check accepts
`IDLE_ACTIVITY_BENCHMARK_CHAIN=/absolute/path/to/corpus` and writes editor display
timings, a deep Find result and container limits to `activity-performance.json`.

The final packaged run contains 1,000,023 operations. Warm editor display is
231.7 ms p95 across five samples after one warm-up. Timing starts when Activity
is opened from an already bound workspace whose initial repository reads have
finished, and ends after rows mount and two animation frames complete. Fewer
than 50 rows are mounted. A separate opening during initial workspace reads
takes 1.44 s and exercises cancellable retries for index contention.

Find selects the exact occurrence for `Activity 987654:` and reports one match.
That query's native result cache was populated by an earlier run; its final
measured time is 219 ms. The whole reference container peaks at 1.37 GiB during
the packaged suite. The [browser results](../outputs/activity-editor-final/reference/activity-performance.json)
retain every display sample and the actual CPU and memory limits.

## Baseline artifacts and validation

The [review VSIX](../outputs/activity-editor-final/idle-activity-editor.vsix)
contains the complete editor and the subsequent mini view. Representative views:
[dense execution graph](../outputs/activity-editor-final/ui/editor-dense.png),
[narrow sidebar](../outputs/activity-editor-final/assembly/activity-mini.png),
[exact editor destination](../outputs/activity-editor-final/assembly/activity-mini-destination.png)
and [million-record editor](../outputs/activity-editor-final/reference/million-record-editor.png).

| Repository | Canonical validation | Result |
| --- | --- | --- |
| EditChain | `scripts/lint.sh` | `RESULT: PASS`, exit 0 |
| Host-tools | `scripts/check.sh`, including `scripts/lint.sh` | `RESULT: PASS`, exit 0 |
| App-core | `scripts/check.sh`, including lint and Swift/Kotlin bindings | `RESULT: PASS`, exit 0 |
| Web-ui | `scripts/check.sh`, including lint and native/WASM builds | `RESULT: PASS`, exit 0 |
| VS Code extension | `scripts/check.sh`, including lint, packaging and native smoke checks | `RESULT: PASS`, exit 0 |
| Integration helper | Python unit tests | 4 passed, exit 0 |

The shared browser fixtures pass 30 of 30 tests; extension JavaScript tests pass
310 of 310. The installed VSIX check uses
VS Code 1.141.0 with a disposable profile and verifies native activation,
capture, exact record/file/diff opens and restart recovery. Packaged browser
checks cover 280-pixel mini rendering, exact editor handoff, live updates and
the existing workspace, repository, authentication and configuration flows.

The dependency records and native candidate bundles are retained under
`outputs/activity-editor-final/dependencies/extension/`; complete validation
logs are under `outputs/activity-editor-final/logs/`. Temporary Cargo overrides
are confined to the integration runner. The normal source manifests continue
to declare registry dependencies for the release order above.
The `changes/` directory contains a patch for each changed repository, and
`SHA256SUMS` covers the review files.

The eighteen reflected wire structs use narrowly scoped
`#[expect(clippy::unsafe_derive_deserialize, reason = "...")]` attributes. Their
Facet derives add no safety invariants to the serialized fields. The existing
lint policies and thresholds are unchanged.
