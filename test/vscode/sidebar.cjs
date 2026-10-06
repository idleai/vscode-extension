const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

// File commands keep the desktop test independent of private workbench APIs.
exports.activate = async context => {
  const root = process.env.IDLE_SIDEBAR_TEST_ROOT;
  let last;
  let directorySize = 0;
  let originalExecute;
  const repositoryReads = [];
  const timer = setInterval(async () => {
    let request;
    try { request = JSON.parse(await fs.readFile(path.join(root, 'command.json'), 'utf8')); }
    catch { return; }
    if (request.id === last) return;
    last = request.id;
    try {
      let value;
      if (request.traceRepository) {
        const host = await vscode.extensions.getExtension('idleai.idle').activate();
        const execute = host.effects.execute.bind(host.effects);
        host.effects.execute = async (method, params, context) => {
          if (method !== 'app.repository') return execute(method, params, context);
          const entry = { action: params.operation.action, binding: params.binding, initial: params.initial, session: context.session };
          repositoryReads.push(entry);
          try {
            const result = await execute(method, params, context);
            const snapshot = (result.local ?? result).Ok?.Snapshot?.snapshot;
            entry.snapshot = snapshot && { scope: snapshot.scope, sessions: snapshot.sessions, reports: snapshot.reports };
            return result;
          } catch (error) { entry.error = String(error); throw error; }
        };
      } else if (request.repositoryReads) {
        const host = await vscode.extensions.getExtension('idleai.idle').activate();
        value = { reads: repositoryReads, cached: [...host.repository.connections.values()].map(connection => ({
          binding: connection.binding, snapshot: connection.cached?.value.repository,
        })) };
      } else if (request.openFile) {
        await vscode.window.showTextDocument(vscode.Uri.file(request.openFile));
      } else if (request.config) {
        for (const [key, value] of Object.entries(request.config)) {
          await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
        }
      } else if (request.bindings || request.directorySize !== undefined) {
        const host = await vscode.extensions.getExtension('idleai.idle').activate();
        if (request.bindings) value = vscode.workspace.workspaceFolders.map(folder => host.assembly.bindingFor(folder.uri));
        else {
          directorySize = request.directorySize;
          if (!originalExecute) {
            originalExecute = host.effects.execute.bind(host.effects);
            host.effects.execute = async (method, params, context) => {
              const result = await originalExecute(method, params, context);
              if (directorySize && method === 'app.workspace' && params.operation === 'List') {
                const source = result.Ok.Directory[0];
                const fixtures = Array.from({ length: directorySize }, (_, index) => ({ ...source,
                  id: `fixture-workspace-${index}`, name: `List fixture ${String(index).padStart(4, '0')}`,
                  chain: `fixture-chain-${index}`, repositories: [{ id: `fixture-repository-${index}`, name: 'Fixture', remote: null }] }));
                return { Ok: { Directory: [...result.Ok.Directory, ...fixtures] } };
              }
              return result;
            };
          }
          await vscode.commands.executeCommand('idle.workspace.refresh');
        }
      } else value = await vscode.commands.executeCommand(request.command, ...(request.args ?? []));
      await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ id: request.id, ok: true, value }));
    } catch (error) {
      await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ id: request.id, ok: false, error: String(error) }));
    }
  }, 100);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  await fs.writeFile(path.join(root, 'ready.json'), JSON.stringify({ version: vscode.version }));
};
