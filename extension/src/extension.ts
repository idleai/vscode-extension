import * as vscode from "vscode";
import { HostServices } from "./host/services";
import { WorkspaceViewProvider } from "./host/webviews";

let active: HostServices | undefined;

/** The returned services are the integration boundary for the feature modules. */
export function activate(context: vscode.ExtensionContext): HostServices {
  const host = new HostServices(context);
  active = host;
  const provider = new WorkspaceViewProvider(context.extensionUri, host.effects,
    error => host.diagnostics.failure("Webview operation", error));
  const register = (name: string, run: () => unknown) => vscode.commands.registerCommand(name,
    () => host.diagnostics.command(name, run));
  const changed = () => {
    host.presence.disconnect();
    host.history.disconnect();
    host.assembly.reset();
    host.native.reset();
    provider.broadcast("host.configurationChanged", host.configuration.snapshot());
  };
  context.subscriptions.push(
    host, provider,
    host.onDidChangeContext(() => provider.broadcast("host.configurationChanged", host.configuration.snapshot())),
    vscode.window.registerWebviewViewProvider("idle.workspace", provider),
    register("idle.open", () => vscode.commands.executeCommand("idle.workspace.focus")),
    register("idle.openDetail", () => provider.openDetail()),
    register("idle.showOutput", () => host.diagnostics.show()),
    register("idle.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:idleai.idle")),
    register("idle.restartNative", async () => {
      host.configuration.assertTrusted();
      host.native.reset();
      await Promise.all([host.history.restart(), host.capture.restart()]);
      host.diagnostics.append("Native adapters restarted.");
    }),
    register("idle.signIn", async () => {
      const account = await host.credentials.account(true);
      host.capture.useAccount(account?.label);
      if (account) await host.diagnostics.notify("info", `Signed in to GitHub as ${account.label}.`);
    }),
    register("idle.cleanupTunnels", () => host.cleanupTunnels()),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("idle")) changed(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(changed),
    vscode.workspace.onDidGrantWorkspaceTrust(changed),
  );
  host.diagnostics.append("Idle workspace host activated.");
  return host;
}

export async function deactivate(): Promise<void> {
  const host = active;
  active = undefined;
  await host?.shutdown();
}
