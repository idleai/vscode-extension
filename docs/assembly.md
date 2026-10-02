# Extension assembly (f43)

The sidebar and detail panel mount `web_ui::assembly::WorkspaceSurface` over a
persistent `app_core::Core`. Workspace selection, history queries, search,
disclosure, exact record inspection and native opens travel through typed Crux
events and continuations. The two documents have separate presentation state;
capture, bindings and native processes belong to the extension lifetime.

`host.ready` negotiates installed actions before the first workspace request.
Every effect has a document-local transport identity. Context changes immediately
clear the old view and capabilities, retire pending continuations and negotiate
again. Old and duplicate replies cannot populate the new view. Malformed results,
failed sends and request timeouts become visible failures. Closing a document
removes its listener and timers without stopping capture or native services.

## Local history

Each open native folder appears as an independent local workspace. The host
resolves `idle.chainDirectory` against that folder and installs an explicit
workspace/repository/chain binding. Host-local aliases are stable across document
recreation and contain no storage paths. They are local routing identities, not
shared enrollment or authenticated contributor identities. No first-folder
fallback is used for multi-root windows.

`app.workspace` supplies the local directory, snapshots and empty local membership
and presence sets. `app.history` routes reads through the packaged
`idle-history-service` and app-core's engine adapter; native-open queries use the
existing exact history actions. Every read rechecks the installed binding and
Workspace Trust. A missing chain is reported as unavailable. **Refresh history**
reconciles recorded changes while preserving app-core selection/disclosure.

The shared session components are mounted with unavailable actions until a
session provider is connected. Runtime fixtures verify typed session results in
both workspace modes. Production subscription/session/projection/resource and
configuration providers, durable prompt drafts and mutation recovery remain
integration work under f43 with their runtime/backend owners. f17 supplies the
required live running-session lifetime check. The current local host does not
claim live session execution or automatic history subscriptions.

## Assets and checks

The build bundles theme, graph, details and session styles plus the application
WASM. VS Code CSS variables update the shared theme directly. The CSP permits
dynamic style attributes for graph coordinates while keeping style elements and
scripts restricted to packaged assets.

The VSIX includes `idle-editor-service`, `idle-history-service`,
`editchain-vscode-service` and `editchain-peer` for the build host's OS/architecture.
Sibling source repositories are build inputs; an installed extension resolves
only configured absolute executables or its own packaged binaries. Build a
platform-specific VSIX for each destination host.

CI pins the app-core, web-ui and EditChain commits used for local verification.
Publish the paired web-ui and EditChain commits before pushing this extension
branch so checkout can fetch those commits. Local f43 commits have not been pushed.

Run `./scripts/check.sh`, then set `CHROME_BIN` and run `npm run test:webview`
and `npm run test:assembly`. CI runs both browser checks. The latter extracts the
VSIX, generates a synthetic chain, and verifies the sidebar/detail path from
Crux through the native service to exact native previews and host theme updates.
Capture tests also verify edits before opening, with all views closed, and after
reopening the view without replacing the capture session.

The legacy EditChain host still serves the live Codex importer and standalone
peer consumer. Its source retirement conditions are recorded in
[`ASSEMBLY-MIGRATION.md`](../../editchain/extensions/vscode-editchain/ASSEMBLY-MIGRATION.md).
