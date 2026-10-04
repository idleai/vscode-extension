const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fixture, loadWithVSCode, uri } = require('./helpers/vscode.cjs');
const { fakeChild } = require('./fixtures/process-fake.cjs');
const { FrameDecoder, encodeFrame } = require('../out/host/frameDecoder');

const f = fixture();
const { HostConfiguration } = loadWithVSCode('../../out/host/configuration', f.api);
const { CoordinationHost } = loadWithVSCode('../../out/host/coordination', f.api);
const tick = () => new Promise(resolve => setImmediate(resolve));
const binding = { workspace_id: 'workspace', repository_id: 'repository', chain: 'chain' };

async function completes(pending) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Coordinator lifecycle did not settle.')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const action of ['reset', 'shutdown']) test(action + ' during coordinator recovery cancels stale reads and completes', { timeout: 5000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-coordination-host-'));
  const children = [];
  t.after(async () => {
    for (const child of children) { child.emit('exit', 0); child.emit('close'); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const bin = path.join(directory, 'bin', `${process.platform}-${process.arch}`);
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, `idle-coordination${process.platform === 'win32' ? '.exe' : ''}`), '');
  f.context.extensionUri = uri(`file://${directory}`);
  f.context.globalStorageUri = uri(`file://${directory}/storage`);
  t.mock.method(childProcess, 'spawn', () => {
    const child = fakeChild({ ignoresTerm: children.length === 0 });
    children.push(child);
    const decoder = new FrameDecoder(16 * 1024 * 1024, 'big');
    const write = child.stdin.write;
    child.stdin.write = (bytes, callback) => {
      const accepted = write(bytes, callback);
      for (const frame of decoder.push(bytes)) {
        const request = JSON.parse(frame);
        if (request.kind === 'call') queueMicrotask(() => {
          const response = { version: 1, id: request.data.id, result: { Ok: { ready: true } } };
          child.stdout.emit('data', encodeFrame([JSON.stringify(response)], 16 * 1024 * 1024, 'big'));
        });
      }
      return accepted;
    };
    return child;
  });
  const configuration = new HostConfiguration(directory);
  const host = new CoordinationHost(f.context, configuration);
  const config = configuration.forResource(f.api.workspace.workspaceFolders[0].uri);
  const read = () => host.read(config, binding, { command: '{"kind":"snapshot"}' }, { signal: new AbortController().signal, session: 'document', viewKind: 'sidebar' });
  assert.deepEqual(JSON.parse((await read()).native).result.Ok, { ready: true });
  children[0].stdout.emit('end');
  const cancelled = assert.rejects(read(), { code: 'cancelled' });
  await tick();
  const stopped = action === 'shutdown' ? host.shutdown() : undefined;
  if (action === 'reset') { host.reset(); host.reset(); }
  children[0].emit('exit', null, 'SIGTERM');
  children[0].emit('close');
  await completes(cancelled);
  assert.equal(children.length, 1, 'the retired read must not start a replacement process');
  if (action === 'reset') {
    assert.deepEqual(JSON.parse((await completes(read())).native).result.Ok, { ready: true });
    assert.equal(children.length, 2, 'a current read can start a fresh coordinator');
  } else {
    await completes(stopped);
    await assert.rejects(read(), { code: 'cancelled' });
  }
  await completes(host.shutdown());
});
