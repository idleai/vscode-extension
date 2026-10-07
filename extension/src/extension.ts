import * as vscode from "vscode";
import { HostServices } from "./host/services";
import { WorkspaceViewProvider } from "./host/webviews";
import { SIDEBAR_VIEWS } from "./host/viewSelection";
import { NativeSidebar } from "./host/nativeSidebar";

let active: HostServices | undefined;

/** The returned services are the integration boundary for the feature modules. */
export function activate(context: vscode.ExtensionContext): HostServices {
  const host = new HostServices(context);
  active = host;
  const provider = new WorkspaceViewProvider(context, host.effects,
    error => host.diagnostics.failure("Webview operation", error), binding => host.assembly.validateBinding(binding),
    () => host.assembly.defaultBinding());
  const sidebar = new NativeSidebar(context, host.effects, provider,
    error => host.diagnostics.failure("Sidebar operation", error));
  const register = (name: string, run: () => unknown) => vscode.commands.registerCommand(name,
    () => host.diagnostics.command(name, run));
  const changed = () => {
    host.presence.disconnect();
    host.history.disconnect();
    host.assembly.reset();
    provider.broadcast("host.configurationChanged", host.configuration.snapshot());
  };
  context.subscriptions.push(
    host, sidebar, provider,
    host.onDidChangeContext(() => provider.broadcast("host.configurationChanged", host.configuration.snapshot())),
    host.collection.onDidChange(folder => {
      host.activity.refresh();
      try { provider.broadcast("history.changed", { binding: host.assembly.bindingFor(folder) }); }
      catch (error) { host.diagnostics.failure("History notification", error); }
    }),
    host.sharing.onDidChange(folder => {
      host.activity.refresh();
      try { provider.broadcast("history.changed", { binding: host.assembly.bindingFor(folder) }); }
      catch (error) { host.diagnostics.failure("Shared history notification", error); }
    }),
    vscode.window.registerWebviewViewProvider("idle.activity", provider),
    ...Object.entries(SIDEBAR_VIEWS).flatMap(([id, section]) => [
      register(`${id}.openDetail`, () => provider.openDetail(section)),
      register(`${id}.refresh`, () => section === "Activity" ? provider.refresh(section) : sidebar.refresh(section)),
      ...(section === "Activity" ? [] : [register(`${id}.filter`, () => sidebar.filter(id)),
        register(`${id}.clearFilter`, () => sidebar.clearFilter(id))]),
    ]),
    vscode.commands.registerCommand("idle.sidebar.activate", value => host.diagnostics.command("idle.sidebar.activate", () => sidebar.activate(value))),
    register("idle.open", () => vscode.commands.executeCommand("idle.workspace.focus")),
    register("idle.openDetail", () => provider.openDetail()),
    register("idle.workspaceSettings", () => provider.openDetail("Settings")),
    register("idle.agentRules", () => provider.openDetail("AgentRules")),
    register("idle.showOutput", () => host.diagnostics.show()),
    register("idle.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:idleai.idle")),
    register("idle.restartNative", async () => {
      host.configuration.assertTrusted();
      await host.capture.flush();
      await host.sharing.reset(false);
      await host.native.restart();
      host.coordination.reset();
      host.repository.reset();
      provider.broadcast("host.configurationChanged", host.configuration.snapshot());
      await Promise.all([host.history.restart(), host.capture.restart(), host.collection.restart(), host.sharing.reset(true)]);
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
