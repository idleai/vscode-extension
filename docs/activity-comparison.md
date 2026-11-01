# Compare the historical Activity UI with current main

The subsequent implementation and its candidate captures are documented in
[Activity implementation against the shipped original](activity-original-implementation.md).
This document retains the earlier main-versus-original baseline.

`scripts/activity-compare/serve.mjs` runs two interactive webviews on one local
page. Each view uses its production renderer and native history reader. The
browser boundary replaces VS Code messaging; it records editor commands and
resolves their actual contents without opening a VS Code workbench.

The selected historical baseline is the shipped monorepo at
`1e9b321fc668d81f8924df8113b2b3b7645ce5a6`. The earlier `620d888` prototype has a
different layout and is not the baseline for this comparison. The historical
checkout is already available at:

```text
/mnt/hot/ambientlight/.codex/worktrees/activity-parity-shipped
```

The harness is in the separate `f43/activity-comparison` worktree:

```text
/mnt/hot/ambientlight/.codex/worktrees/activity-compare-20261025/vscode-extension
```

Current main is `878128368419a5e2fa451bba3bac291243e623d6`. Its installed files
come from the successful
[CI run 40272991388](https://github.com/idleai/vscode-extension/actions/runs/40272991388),
artifact `idle-vscode`. The native executable and WebAssembly bytes are taken
from that VSIX. The historical executable was built from the historical
checkout. Every run records executable, renderer, bundle, and input hashes.

## Start the prepared comparison

From the harness worktree:

```sh
node scripts/activity-compare/serve.mjs \
  --legacy-root /mnt/hot/ambientlight/.codex/worktrees/activity-parity-shipped \
  --legacy-service /mnt/hot/ambientlight/repos/host-tools/target/timeline-dev/parity/baseline/shipped-build/release/editchain-vscode-service \
  --current-root outputs/activity-compare/current-artifact/unpacked/extension \
  --current-revision 878128368419a5e2fa451bba3bac291243e623d6 \
  --workspace /mnt/hot/ambientlight/repos/host-tools/target/timeline-dev/parity/corpus/source-matching-workspace \
  --port 4173
```

Open <http://127.0.0.1:4173/>. The server stays running until interrupted.
Each start creates a fresh run directory under `outputs/activity-compare/runs`.
`latest.json` names that directory and URL. Starting a new server run gives
both sides fresh private state. Reload views recreates the pages; the current
side keeps its shared native host and generated indexes for the server run.

For another recorded checkout, pass its path as `--workspace`. It must have
a self-contained `.git` directory and `.editchain` raw logs and blobs. The
server copies those inputs separately, excludes old generated indexes, and
verifies matching hashes, Git HEAD, and refs. Tracking and live provider
imports are disabled. The source checkout is read without modification.

This prepared corpus contains 324 log files and 1,295 blobs. Its frozen Git
HEAD is `86af18f9d9a41c14cbb8b81d2becfc84e2ca11a7`, with 34 commits. It is the
history being displayed, independent of the revisions of the two applications.

## Operate the comparison

The controls above the panes belong to the harness. Controls inside each pane
belong to the original application.

| Action | How to use it |
| --- | --- |
| Compare the same viewport | Set Pane width and Pane height. Both inner viewports get those exact dimensions and are scaled equally to fit. |
| Work at normal size | Open full size for either pane. This also avoids coordinate conversion during manual automation. |
| All activity / Git only | Use the History selector. Git only opens the old reader with an empty raw chain and the same Git checkout; on current it selects the real Git filter. |
| Scroll both | The slider moves both native table viewports to a percentage. Row order and row counts can differ, so use record details to align a comparison. |
| Keep a comparison state | Save checkpoint writes both DOM snapshots, visible rows, row identities, geometry, graph markup, and scroll position. |
| Inspect open actions | Expand Actions and editor opens. The full native and browser transcript is in `events.jsonl`; current opened text is also written under `current/opened/`. |

The old UI has no original Git/all filter control. Its search finds and moves
between matching rows; search may disclose rows. It does not produce a
filtered table. Current Find also navigates matches, while View options owns
the activity-kind filter.

| Interaction | Old monorepo | Current extension |
| --- | --- | --- |
| Task disclosure | Click the activity-count chevron in Tags. | Click the row's disclosure chevron. |
| Git commit | The row disclosure adds inline file children. | One row click requests the normal commit patch editor. |
| File change | Click a file row to request its diff. | Click a file-change row to request its recorded diff. |
| Find | Search field, Enter, next/previous buttons; Shift+Enter goes back; Escape clears. | Find field, Find button, Next/Previous match, Clear activity Find. |
| Keyboard | Tab to a row; Up/Down move focus while retaining selection, Left/Right disclose, Enter activates the focused row. | Focus the table; Up/Down move the selected row without another editor-open request. |

Do not compare full Git row IDs: each reader derives a repository ID from its
workspace path. Match the terminal commit OID. Provider records also have
different ID formats. The included smoke scenario matches a unique timestamp
and checks the same task size, retaining both IDs in its results.

## Repeat the interaction checks and captures

Install the harness worktree's Node dependencies with `npm ci --ignore-scripts`
if needed. With the server running:

```sh
CHROME_BIN=/mnt/hot/ambientlight/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome \
  node scripts/activity-compare/smoke.mjs \
  http://127.0.0.1:4173 outputs/activity-compare/captures
```

The smoke scenario expects a recorded corpus with Git history, a provider
task in the first native window, and searchable activity text. It exercises
real pointer and keyboard input in the paired page. Its click helper converts
iframe-local rectangles to scaled page coordinates; ordinary automation
click helpers can otherwise land on an adjacent row.

The output includes paired PNGs and DOM JSON for the initial table, collapsed
and expanded task, Git click/file actions, and Find/Next. `summary.json`
records the checks and any browser errors. `current-commit.diff` and
`legacy-file.json` contain resolved native open results. `events.jsonl` in the
server run contains every native request/reply and observed UI action.

The supplied corpus starts with 224 visible rows and 799 underlying
activities. Its matched 28-activity task expands the table to 251 rows on
both sides. Git-only Find for `activity` returns 7 matches in the old view
and 4 in current main. The checks verify functioning interactions and record
these differences; matching initial counts alone do not establish behavioral
parity. `summary.json` includes the transcript sequence range for that check.
Current main's first preparation can take several minutes; the
UI reports its native build progress. Later views reuse the prepared host.

## Group reveal and minimize

The focused interaction capture uses the same builds and recorded history.
Run it while the comparison server is running:

```sh
CHROME_BIN=/mnt/hot/ambientlight/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome \
  node scripts/activity-compare/groups.mjs
```

The [animated cycle](../outputs/activity-compare/groups/provider-cycle.gif)
shows real clicks, marked by yellow rings, on the matched 28-activity group.
The static stages are
[collapsed](../outputs/activity-compare/groups/provider-1-collapsed.png),
[revealed](../outputs/activity-compare/groups/provider-2-revealed.png), and
[minimized again](../outputs/activity-compare/groups/provider-3-minimized.png).

Both views complete the same disclosure cycle: 224 → 251 → 224 rows. The
original group summary, scroll position, and group position are restored.
A three-activity human group also passes: 224 → 226 → 224. Disclosure-button
clicks do not open an editor. Collapsing after selecting a child leaves no
selected row visible in either view.

The other interaction results below concern the 28-activity provider group:

| Action | Old monorepo | Current extension |
| --- | --- | --- |
| Click the disclosure control | Reveals or minimizes the group. The entire count badge is the button. | Reveals or minimizes the group using the separate chevron. |
| Click the activity count | Toggles the group in either state. | Requests record JSON; group state stays unchanged. |
| Click Content while collapsed | Selects the summary and reveals the group. | Selects the row and requests JSON; group stays collapsed. |
| Click Content while revealed | Selects the physical record; group stays revealed. | Selects the record and requests JSON; group stays revealed. |
| Focus the disclosure button and press Enter twice | First reveals, then focus moves to the row. Second requests JSON and leaves the group revealed. | Focus stays on the button. First reveals; second minimizes. |

For this group, the old button measures about 93 × 22 CSS pixels; the new
chevron button measures 18 × 24. Those measurements are inside the unscaled
webviews. Clicking the new count badge or summary therefore invokes record
opening even where the old UI would reveal the group. Editor-open requests
and their resolved JSON are recorded by the harness.

Use explicit Content selectors when automating: `.text-cell` on old,
`.idle-timeline-content` on current. The old renderer can insert a group label
before its cells, so child indexes do not identify the same column reliably.
Group expansion is on the task button's `aria-expanded`; the old row's own
`aria-expanded` describes a separate record-detail disclosure.

The final run records 24 actions and 12 paired captures in
`outputs/activity-compare/groups`. `summary.json` contains before/after
selection, focus, row counts, scroll offsets, and native open requests, with
the corresponding transcript sequence range. The capture check passed with
zero browser or bridge errors. `./scripts/lint.sh` exited 0, `RESULT: PASS`;
its log is `outputs/activity-compare/groups-lint.log`.

## Compare the rendering of the same rows

The focused row capture aligns actual webviews by matching records, then crops
their different header heights outside the frames. Both retain a 1,200-pixel
inner width and their original 34-pixel rows. The numbered gutters belong to
the harness; product text, columns, colors, and graph paths remain unchanged.

With the prepared frozen-input ID map at
`outputs/activity-compare/same-rows/identity-map.json`, run:

```sh
CHROME_BIN=/mnt/hot/ambientlight/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome \
  node scripts/activity-compare/same-rows.mjs
```

The script requires the map's input digest to equal the server's frozen-input
digest. Each captured pair must share an actual physical operation ID, or the
exact commit OID for a Git row, and timestamp. It also checks consecutive row
order, equal heights, and aligned screen positions. A matching timestamp or
similar summary alone is insufficient.

The outputs include provider collapsed, revealed, all 28 members, and minimized
views, plus a human group's collapsed and revealed views. Each PNG has a JSON
file containing the original DOM snapshots, both row IDs, shared operation
IDs, and rendering fields. `summary.json` records the complete checks.

Open the aligned [collapsed provider rows](../outputs/activity-compare/same-rows/provider-collapsed.png),
[revealed provider rows](../outputs/activity-compare/same-rows/provider-revealed.png),
[all 28 provider activities](../outputs/activity-compare/same-rows/provider-all-members.png),
[minimized provider rows](../outputs/activity-compare/same-rows/provider-minimized.png),
or [three revealed human activities with surrounding rows](../outputs/activity-compare/same-rows/human-revealed.png).
Old is on the left and current is on the right. Row numbers correspond within
each image; revealing a group inserts its members and changes subsequent numbers.

The final capture run passed 70 pair comparisons across six images, covering
43 distinct item pairs, with no browser or bridge errors. The minimized provider
view restores the same eight rows and native summaries as the collapsed view.
Visible differences include graph lanes, the disclosure button's position,
author/status tags, content icons, and preview formatting. The complete source
group membership matches on both sides: 28 provider activities and 3 human
activities. The current lint run exited 0, `RESULT: PASS`; its log is
`outputs/activity-compare/same-rows-lint.log`.

## Rebuild or replace inputs

To create the historical checkout elsewhere, use `git worktree add --detach`
from the monorepo with the full historical commit above. Its production
renderer assets are under `extensions/vscode-editchain/media/rust-history`.
If rebuilding is required, use that checkout's `npm run build:renderer` in
`extensions/vscode-editchain`, and build the native executable from its root:

```sh
cargo build --release -p editchain-node --bin editchain-vscode-service
```

To replace the prepared current build, download and extract the VSIX for the
chosen successful CI run, then pass the extracted `extension` directory and
that run's exact commit ID. The prepared download used:

```sh
gh run download 40272991388 --repo idleai/vscode-extension \
  --name idle-vscode --dir outputs/activity-compare/current-artifact
unzip outputs/activity-compare/current-artifact/idle.vsix \
  -d outputs/activity-compare/current-artifact/unpacked
```

## Scope and checks

This compares the Activity editor webviews, their native data queries, and
their open requests. It does not reproduce the VS Code workbench, actual
editor tabs, extension installation, live recording, account access, or
cross-restart view restoration. The native services run locally on this
machine. A Git-only profile compares Git rendering with the different
filtering mechanisms described above.

The historical adapter starts a fresh private raw-chain copy for each page.
It checks that copy before and after native shutdown. The harness checks the
two workspace copies on shutdown as well. No historical product sources or
lockfiles were changed to make the views agree.

Required current `./scripts/lint.sh`: exit 0, `RESULT: PASS`.
Required historical `./scripts/lint.sh`: exit 1. Formatting, Clippy, tests,
and documentation checks passed; `cargo deny` failed on six current
advisories affecting rustls, rustls-webpki, and tokio in the historical
lockfile. Logs are `outputs/activity-compare/lint.log` and
`outputs/activity-compare-legacy/legacy-lint.log` in the harness worktree.
