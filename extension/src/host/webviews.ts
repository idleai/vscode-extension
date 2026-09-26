import * as vscode from "vscode";

/** Minimal mounting only. f38/f43 own host capabilities and application assembly. */
export class WorkspaceViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const assets = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [assets],
    };
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, "bootstrap.js"));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, "theme.css"));
    const source = view.webview.cspSource;
    view.webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${source} 'wasm-unsafe-eval'; style-src ${source}; connect-src ${source};">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Idle</title>
  <link rel="stylesheet" href="${style}">
</head>
<body>
  <div id="main" role="region" aria-label="Idle application">Starting Idle…</div>
  <script type="module" src="${script}"></script>
</body>
</html>`;
  }
}
