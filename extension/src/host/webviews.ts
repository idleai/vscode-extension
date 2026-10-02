import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { HostEffects } from "./effects";
import { WebviewBridge } from "./messageBridge";

/** View lifetimes own only message listeners; native adapters belong to the extension. */
export class WorkspaceViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly views = new Set<{ bridge: WebviewBridge; dispose(): void }>();
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly effects: HostEffects,
    private readonly failure: (error: unknown) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void { this.mount(view, "sidebar"); }

  openDetail(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel("idle.detail", "Idle", vscode.ViewColumn.Active, {});
    this.panel = panel;
    this.mount(panel, "detail");
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
  }

  private mount(view: vscode.WebviewView | vscode.WebviewPanel, kind: string): void {
    const session = randomBytes(24).toString("hex");
    const assets = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [assets] };
    const bridge = new WebviewBridge(session, this.effects,
      message => view.webview.postMessage(message), this.failure);
    const receive = view.webview.onDidReceiveMessage(message => { void bridge.receive(message); });
    const entry = { bridge, dispose: () => { bridge.dispose(); receive.dispose(); closed.dispose(); this.views.delete(entry); } };
    const closed = view.onDidDispose(entry.dispose);
    this.views.add(entry);
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, "bootstrap.js")).toString();
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, "theme.css")).toString();
    view.webview.html = webviewHtml(view.webview.cspSource, script, style, session, kind);
  }

  broadcast(event: string, params: unknown): void {
    for (const view of this.views) void view.bridge.event(event, params);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const view of this.views) view.dispose();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export function webviewHtml(source: string, script: string, style: string, session: string, kind: string): string {
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
<body>
  <div id="main" role="region" aria-label="Idle application" data-host-session="${escapeHtml(session)}" data-view-kind="${escapeHtml(kind)}">Starting Idle…</div>
  <script nonce="${nonce}" type="module" src="${escapeHtml(script)}"></script>
</body>
</html>`;
}
