import * as vscode from 'vscode';
import { HostServices } from './services';
import { WorkspaceViewProvider } from './webviews';
import { HostError } from './protocol';

/** Pairing is an explicit command; private invitations never enter a webview. */
export function runtimeCommands(host: HostServices, views: WorkspaceViewProvider): vscode.Disposable[] {
  const selected = async () => {
    host.configuration.assertTrusted();
    let binding = views.ensureWorkspace();
    if (!binding) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const selected = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })),
        { placeHolder: 'Choose the workspace for this compute connection' });
      if (!selected) return undefined;
      binding = host.assembly.ensureBindingFor(selected.folder.uri);
    }
    return { binding, config: host.assembly.configurationFor(binding) };
  };
  const register = (name: string, run: () => Promise<void>) => vscode.commands.registerCommand(name,
    () => host.diagnostics.command(name, run));
  return [
    register('idle.compute.request', async () => {
      const context = await selected();
      if (!context) return;
      await vscode.env.clipboard.writeText(await host.runtime.connectionRequest(context.binding));
      await host.diagnostics.notify('info', 'Compute connection request copied. Give it to the compute machine owner.');
    }),
    register('idle.compute.connect', async () => {
      const context = await selected();
      if (!context) return;
      const invitation = await vscode.window.showInputBox({ title: 'Connect Compute Host', password: true,
        prompt: 'Paste the private invitation created on the compute machine', ignoreFocusOut: true });
      if (invitation === undefined) return;
      host.assembly.validateBinding(context.binding);
      try { await host.runtime.connect(context.config, context.binding, invitation); }
      catch (error) {
        if (error instanceof HostError && error.code === 'incompatible_host') throw error;
        throw new HostError('unavailable', 'Could not connect. Check that the invitation matches this workspace, is current, and the compute daemon is running.');
      }
      await host.diagnostics.notify('info', 'Compute host connected. Open Compute hosts to see its status.');
    }),
    register('idle.compute.disconnect', async () => {
      const context = await selected();
      if (!context) return;
      await host.runtime.disconnect(context.binding);
      await host.diagnostics.notify('info', 'Saved compute connection removed. The compute daemon is still running.');
    }),
  ];
}
