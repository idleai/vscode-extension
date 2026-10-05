const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fixture, loadWithVSCode, uri } = require('./helpers/vscode.cjs');
const { harness } = require('./fixtures/native-host-fake.cjs');

const f = fixture();
const { HostConfiguration } = loadWithVSCode('../../out/host/configuration', f.api);
const { CoordinationHost } = loadWithVSCode('../../out/host/coordination', f.api);
const tick = () => new Promise(resolve => setImmediate(resolve));
const binding = { workspace_id: 'workspace', repository_id: 'repository', chain: 'chain' };
const versions = { service: 1, repository_api: 1, invitation: 1, saved_sharing: 1 };

for (const action of ['reset', 'shutdown']) test(action + ' during coordinator recovery cancels stale reads and completes', { timeout: 5000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-coordination-host-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  f.context.globalStorageUri = uri(`file://${directory}/storage`);
  const native = harness(t, { ignoresTerm: true, request(channel, request) {
    if (request.kind !== 'call') return;
    channel.reply({ version: 1, id: request.data.id,
      result: { Ok: request.data.command.kind === 'versions' ? versions : { ready: true } } });
  } });
  const configuration = new HostConfiguration(directory);
  const host = new CoordinationHost(f.context, configuration, native.host);
  const config = configuration.forResource(f.api.workspace.workspaceFolders[0].uri);
  const read = () => host.read(config, binding, { command: '{"kind":"snapshot"}' },
    { signal: new AbortController().signal, session: 'document', viewKind: 'sidebar' });
  assert.deepEqual(JSON.parse((await read()).native).result.Ok, { ready: true });
  native.processes[0].stdout.emit('end');
  const cancelled = assert.rejects(read(), { code: 'cancelled' });
  await tick();
  const stopped = action === 'shutdown' ? host.shutdown() : undefined;
  if (action === 'reset') { host.reset(); host.reset(); }
  await cancelled;
  native.processes[0].emit('exit', null, 'SIGTERM');
  native.processes[0].emit('close');
  await tick();
  assert.equal(native.processes.length, 1, 'the retired read must not start a replacement process');
  if (action === 'reset') {
    assert.deepEqual(JSON.parse((await read()).native).result.Ok, { ready: true });
    assert.equal(native.processes.length, 2, 'a current read can start the replacement host');
  } else {
    await stopped;
    await assert.rejects(read(), { code: 'cancelled' });
  }
  await host.shutdown();
});
