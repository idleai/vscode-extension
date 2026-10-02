# Extension assembly handoff (f43)

The new Idle package in `idleai/vscode-extension` mounts the shared web-ui
workspace/history/session components over app-core. Local history discovery,
queries, exact record inspection and native file/diff actions use explicit
folder bindings and the packaged engine service. Capture belongs to activation,
including when views are closed. Its VSIX contains all native/WASM assets for
the build host's platform and requires no source checkout at runtime.

The source extraction is complete. EditChain contains only the engine and CLI.
This repository owns `editchain-node`, `editchain-editor-protocol`, both extension
packages, editor integrations and the renderer CI job. App-core owns semantic
projections, shared contracts and `editchain-client-state`; web-ui owns graph
geometry, the renderer and its CSS. Codex owns `tools/codex-session-exporter` and
`tools/history-runtime` for portable peer coordination and discovery.

The peer adapter's Node import path and class APIs are unchanged. It remains a
small module backed by app-core's `idle-history`. `npm run build:client-state`
builds it without the renderer. `npm run build:renderer` builds both committed
asset trees, and CI checks their reproducibility and WASM lint results.

The remaining legacy extension is still an active consumer. Keep its existing
commands, capture recovery and live-history behavior runnable while the following
callers switch. Installing the new VSIX alone does not migrate legacy settings or
pending capture outboxes. Use one capture owner for a workspace during migration;
drain the old capture outbox before disabling its tracking.

| Remaining source | Removal condition and owner |
| --- | --- |
| Codex `tools/codex-session-exporter`, extension live import adapters and native live import calls | f10 completes native runtime recording and importer/native reconciliation while retaining raw records, retry identities and ongoing capture. The exporter source move is complete. |
| Codex `tools/history-runtime`, VS Code transport/command adapters, app-core peer state and its packaged WASM | f18 completes the standalone Evo service, configuration and provider connections. Portable coordination source has moved; sharing approval, reconnect state and cleanup behavior remain covered by the host integration tests. |
| `src/humanWork.ts`, editor capture adapters and native editor compatibility entrypoints | f43 completes the installed-host/settings/outbox handoff to the f39 owner. The old extension still uses these while its users migrate. |
| Legacy `extension.ts` document providers and history command wiring | f43 switches the remaining legacy commands to f40's bound native actions. The new Idle view already uses f40 directly. |
| `editchain-history-renderer::app` / `shell`, `media/main.css`, `media/rust-history/`, coordinate-based service endpoints and geometry/protocol re-exports | f43 retires the old extension mount after those live consumers switch; f60 owns any remaining browser host caller. Replacement browser/native interaction tests must continue covering the retired behavior. |

The engine schema, store, indexes, queries, replication and CLI remain in EditChain.
Shared state and rendering remain in app-core/web-ui. This handoff does not mark
production runtime connections or complete legacy source retirement as finished.
