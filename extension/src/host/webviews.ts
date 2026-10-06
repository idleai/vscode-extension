import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { HostEffects } from "./effects";
import { WebviewBridge } from "./messageBridge";
import { RepositoryBinding } from "../history";
import { detailTarget, SIDEBAR_VIEWS } from "./viewSelection";
import { HostError, record } from "./protocol";

/** View lifetimes own only message listeners; native adapters belong to the extension. */
export class WorkspaceViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly views = new Set<{ bridge: WebviewBridge; kind: string; section?: string; dispose(): void }>();
  private panel: vscode.WebviewPanel | undefined;
  private selection: RepositoryBinding | undefined;
  private destination: Record<string, unknown> | undefined;
  private readonly handlers: vscode.Disposable[];
  private readonly events = new vscode.EventEmitter<{ event: string; params: unknown }>();
  readonly onDidBroadcast = this.events.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly effects: HostEffects,
    private readonly failure: (error: unknown) => void,
    private readonly validate: (binding: unknown) => RepositoryBinding,
    private readonly defaultWorkspace: () => RepositoryBinding | undefined = () => undefined,
  ) {
    this.selection = context.workspaceState.get<RepositoryBinding>("sidebar.workspace");
    this.handlers = [
      effects.register("views.selectWorkspace", params => this.selectWorkspace(record(params) ? params.binding : undefined)),
      effects.register("views.openDetail", params => this.openTarget(params)),
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void { this.mount(view, "sidebar", SIDEBAR_VIEWS[view.viewType]); }

  get selectedWorkspace(): RepositoryBinding | undefined { return this.selection; }

  /** Restore a valid explicit choice before choosing the current local folder. */
  ensureWorkspace(): RepositoryBinding | undefined {
    const saved = this.selection ?? this.context.workspaceState.get<RepositoryBinding>("sidebar.workspace");
    if (saved) {
      try { this.selection = this.validate(saved); return this.selection; }
      catch { this.selection = undefined; this.destination = undefined; }
    }
    try {
      const binding = this.defaultWorkspace();
      if (binding) void Promise.resolve(this.selectWorkspace(binding)).catch(this.failure);
      return binding;
    } catch { return undefined; }
  }

  selectWorkspace(value: unknown): Thenable<void> {
    const binding = this.validate(value);
    this.selection = binding;
    this.destination = undefined;
    this.broadcast("host.workspaceSelected", binding);
    return this.context.workspaceState.update("sidebar.workspace", binding);
  }

  openTarget(value: unknown): void {
    const target = detailTarget(value, this.validate);
    const binding = target.binding as RepositoryBinding;
    if (this.selection && (binding.workspace_id !== this.selection.workspace_id || binding.repository_id !== this.selection.repository_id || binding.chain !== this.selection.chain)) {
      throw new HostError("unavailable", "The workspace selection changed. Select the row again.");
    }
    this.destination = target;
    this.openDetail();
  }

  openDetail(section?: string): void {
    this.ensureWorkspace();
    if (section && this.selection) this.destination = detailTarget({ binding: this.selection, section }, this.validate);
    if (this.panel) {
      this.panel.reveal();
      for (const view of this.views) if (view.kind === "detail") this.restore(view);
      return;
    }
    const panel = vscode.window.createWebviewPanel("idle.detail", "Idle", vscode.ViewColumn.Active, {});
    this.panel = panel;
    this.mount(panel, "detail");
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
  }

  refresh(section: string): void {
    for (const view of this.views) if (view.section === section) void view.bridge.event("host.configurationChanged", {});
  }

  private restore(view: { bridge: WebviewBridge; kind: string }): void {
    this.ensureWorkspace();
    if (this.selection) void view.bridge.event("host.workspaceSelected", this.selection);
    if (view.kind === "detail" && this.destination) void view.bridge.event("host.navigate", this.destination);
  }

  private mount(view: vscode.WebviewView | vscode.WebviewPanel, kind: string, section?: string): void {
    const session = randomBytes(24).toString("hex");
    const assets = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [assets] };
    const bridge = new WebviewBridge(session, this.effects,
      message => view.webview.postMessage(message), this.failure, kind);
    const receive = view.webview.onDidReceiveMessage(message => {
      void bridge.receive(message).then(() => {
        if (message?.method === "host.ready") {
          void bridge.event("host.appearance", workbenchAppearance());
          this.restore(entry);
        }
      });
    });
    const appearance = vscode.workspace.onDidChangeConfiguration(event => {
      if (["workbench.experimental", "window.density"].some(key => event.affectsConfiguration(key))) {
        void bridge.event("host.appearance", workbenchAppearance());
      }
    });
    const entry = { bridge, kind, section, dispose: () => { bridge.dispose(); receive.dispose(); appearance.dispose(); closed.dispose(); this.views.delete(entry); } };
    const closed = view.onDidDispose(entry.dispose);
    this.views.add(entry);
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, "bootstrap.js")).toString();
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, "theme.css")).toString();
    view.webview.html = webviewHtml(view.webview.cspSource, script, style, session, kind, workbenchAppearance(), section);
  }

  broadcast(event: string, params: unknown): void {
    this.events.fire({ event, params });
    for (const view of this.views) void view.bridge.event(event, params);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const view of this.views) view.dispose();
    for (const handler of this.handlers) handler.dispose();
    this.events.dispose();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

interface WorkbenchAppearance { modern: boolean; compact: boolean; uppercase: boolean }

function workbenchAppearance(): WorkbenchAppearance {
  const config = vscode.workspace.getConfiguration();
  return {
    modern: config.get<boolean>("workbench.experimental.modernUI", false),
    compact: config.get<string>("window.density.layout") === "compact",
    uppercase: config.get<boolean>("workbench.experimental.modernUIUppercaseViewHeaders", false),
  };
}

export function webviewHtml(source: string, script: string, style: string, session: string, kind: string,
  appearance: WorkbenchAppearance = { modern: false, compact: false, uppercase: false }, section = ""): string {
  const nonce = randomBytes(24).toString("hex");
  const csp = `default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'nonce-${nonce}' ${source} 'wasm-unsafe-eval'; style-src ${source}; style-src-attr 'unsafe-inline'; img-src ${source} data:; font-src ${source}; connect-src ${source};`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Idle</title>
  <link rel="stylesheet" href="${escapeHtml(style)}">
</head>
<body data-vscode-modern="${appearance.modern}" data-vscode-compact="${appearance.compact}" data-vscode-uppercase="${appearance.uppercase}">
  <div id="main" role="region" aria-label="Idle application" data-host-session="${escapeHtml(session)}" data-view-kind="${escapeHtml(kind)}" data-view-section="${escapeHtml(section)}">Starting Idle…</div>
  <script nonce="${nonce}" type="module" src="${escapeHtml(script)}"></script>
</body>
</html>`;
}
