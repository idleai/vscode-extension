import * as vscode from "vscode";
import { WorkspaceViewProvider } from "./host/webviews";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new WorkspaceViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("idle.workspace", provider),
    vscode.commands.registerCommand("idle.open", () =>
      vscode.commands.executeCommand("idle.workspace.focus"),
    ),
  );
}

export function deactivate(): void {}
