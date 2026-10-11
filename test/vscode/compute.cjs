'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
  const directory = process.env.IDLE_COMPUTE_TEST_DIR;
  const phase = process.env.IDLE_TEST_PHASE;
  const progress = step => fs.appendFile(path.join(directory, `${phase}-progress.jsonl`),
    JSON.stringify({ step, at: Date.now() }) + '\n');
  await progress('activation started');
  const installed = vscode.extensions.getExtension('idleai.idle');
  assert.ok(installed, 'the packaged extension is installed');
  const host = await installed.activate();
  await progress('extension activated');
  const binding = host.assembly.defaultBinding();
  assert.ok(binding, 'the desktop has a workspace binding');
  const config = host.assembly.configurationFor(binding);
  const context = { signal: new AbortController().signal, session: 'desktop-compute' };
  const read = async command => {
    await progress(`${command.kind} started`);
    const response = await host.coordination.read(config, binding,
      { command: JSON.stringify(command), drafts: '[]' }, context);
    await progress(`${command.kind} completed`);
    return JSON.parse(response.native).result.Ok;
  };
  const save = async (id, json, expected) => {
    const contributor = await host.coordination.contributor();
    return read({ kind: 'mutate', data: { api_version: '1', control_fence: null,
      context: { workspace_id: binding.workspace_id, request_id: id, expires_at: String(Date.now() + 3600_000),
        contributor: { contributor_id: contributor,
          authenticated_as: { issuer: 'idle-vscode-local', subject: contributor.slice('local-contributor:'.length) } } },
      body: { kind: 'configuration', data: { document: 'Settings',
        change: { expected, value: { schema_version: 1, json } } } } } });
  };
  let result = { passed: true, phase, version: vscode.version };
  try {
    if (phase === 'prepare') {
      await read({ kind: 'snapshot' });
      assert.equal((await save('desktop-before', '{"savedBeforeTransfer":true}', { kind: 'absent' })).result.status, 'success');
      await fs.writeFile(path.join(directory, 'request', 'request.json'), await host.runtime.connectionRequest(binding));
      await fs.writeFile(path.join(directory, 'before.json'), JSON.stringify(await read({ kind: 'snapshot' })));
    } else {
      if (phase === 'connect') {
        await progress('pairing started');
        await host.runtime.connect(config, binding, await fs.readFile(path.join(directory, 'invitation.txt'), 'utf8'));
        await progress('pairing completed');
        await host.coordination.moveToRuntime(config, binding);
        await progress('transfer completed');
        const before = JSON.parse(await fs.readFile(path.join(directory, 'before.json'), 'utf8'));
        assert.deepEqual(await read({ kind: 'snapshot' }), before, 'transfer retains the original workspace state');
        assert.equal((await save('desktop-after', '{"savedOnRemoteCompute":true}',
          { kind: 'revision', value: before.settings.revision })).result.status, 'success');
      }
      await progress('runtime snapshot started');
      const observation = await host.runtime.snapshot(config, binding);
      await progress('runtime snapshot completed');
      assert.ok(observation?.connected, 'the saved invitation connects to the remote daemon');
      assert.ok(observation.status.workspaces[0].available, 'the compute checkout is available');
      const snapshot = await read({ kind: 'snapshot' });
      assert.deepEqual(JSON.parse(snapshot.settings.value.json), { savedOnRemoteCompute: true });
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.cwd, '.idle/workspace/settings.json'), 'utf8')),
        { savedBeforeTransfer: true }, 'coordination writes affect only the compute checkout');
      result = { ...result, hostId: observation.status.hostId, runtimeId: observation.status.runtimeId,
        settings: snapshot.settings, workspace: binding.workspace_id };
      if (phase === 'restore') {
        const previous = JSON.parse(await fs.readFile(path.join(directory, 'connect.json'), 'utf8'));
        const { runnerId, ...coordination } = previous;
        assert.deepEqual({ ...result, phase: 'connect' }, coordination,
          'a complete desktop restart retains the same host, daemon and saved configuration');
      }
      await vscode.commands.executeCommand('workbench.view.extension.idle');
      await vscode.commands.executeCommand('idle.computeHosts.refresh');
      await progress('compute view refreshed');
      if (process.env.IDLE_COMPUTE_RUNNER === '1') {
        const runner = await require('./compute-runner.cjs').run(host, config, binding, directory, phase, progress);
        result = { ...result, ...runner };
      }
    }
  } finally { await progress('shutdown started'); await host.shutdown(); await progress('shutdown completed'); }
  await fs.writeFile(path.join(directory, `${phase}.json`), JSON.stringify(result));
};
