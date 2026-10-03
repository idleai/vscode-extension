const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
  const installed = vscode.extensions.getExtension('idleai.idle');
  assert.ok(installed, 'Idle is installed from the VSIX');
  assert.ok(!installed.extensionPath.includes('/repos/'), 'the installed extension runs outside source checkouts');
  const host = await installed.activate();
  assert.equal(vscode.workspace.isTrusted, true);
  const root = process.env.IDLE_TEST_ROOT;
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'history.json'), 'utf8'));
  const context = { session: 'installed-vscode-test', signal: new AbortController().signal };
  const directory = await host.effects.execute('app.workspace', { operation: 'List' }, context);
  assert.equal(directory.Ok.Directory.length, 1);
  const workspace = directory.Ok.Directory[0];
  const binding = { workspace_id: workspace.id, repository_id: workspace.repositories[0].id, chain: workspace.chain };
  const raw = await host.effects.execute('app.coordination', { binding, command: '{"kind":"snapshot"}' }, context);
  assert.equal(JSON.parse(raw.native).result.Ok.workspace.value.id, binding.workspace_id);
  const document = await vscode.workspace.openTextDocument(path.join(root, 'capture.txt'));
  const editor = await vscode.window.showTextDocument(document);
  await host.capture.snapshot();
  await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'first edit\n'));
  assert.equal(await host.capture.flush(), true);
  const captured = host.capture.revision(document);
  assert.ok(captured, 'capture starts before opening a view');
  await vscode.commands.executeCommand('idle.open');
  await vscode.commands.executeCommand('idle.openDetail');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  const reopened = await vscode.window.showTextDocument(document);
  await reopened.edit(edit => edit.insert(new vscode.Position(0, 0), 'view closed edit\n'));
  assert.equal(await host.capture.flush(), true);
  assert.equal(host.capture.revision(document).session, captured.session);
  await vscode.commands.executeCommand('idle.open');
  await vscode.commands.executeCommand('idle.openDetail');
  for (const [index, expected] of [[0, [fixture.after]], [1, [fixture.before, fixture.after]], [2, [fixture.encoded]], [3, [fixture.raw]]]) {
    const result = await host.history.open({ ...fixture.requests[index], binding });
    for (let part = 0; part < expected.length; part++) {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(result.byteUris[part]));
      assert.deepEqual(Buffer.from(bytes), Buffer.from(expected[part]));
    }
  }
  const activity = await host.history.activity({ binding, source: 'current', selection: { Record: fixture.requests[0].record } }, context.signal);
  assert.deepEqual(activity.record, fixture.requests[0].record);
  assert.equal(activity.text, Buffer.from(fixture.after).toString('utf8'));
  assert.equal(host.capture.revision(document).session, captured.session);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await fs.writeFile(process.env.IDLE_TEST_REPORT, JSON.stringify({ passed: true, version: vscode.version }));
};
