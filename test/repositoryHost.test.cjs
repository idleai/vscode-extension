const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fixture, loadWithVSCode, uri } = require('./helpers/vscode.cjs');
const { fakeChild } = require('./fixtures/process-fake.cjs');
const { FrameDecoder } = require('../out/host/frameDecoder');
const { HostEffects } = require('../out/host/effects');
const f = fixture();
const { HostConfiguration } = loadWithVSCode('../../out/host/configuration', f.api);
const { RepositoryHost } = loadWithVSCode('../../out/host/repository', f.api);
const { AssemblyHost } = loadWithVSCode('../../out/host/assembly', f.api);
const tick = () => new Promise(resolve => setImmediate(resolve));
const binding = { workspace_id: 'workspace', repository_id: 'repository', chain: 'chain' };
const operation = action => ({ operation: { context: { connection: { provider: 'idle-local', workspace: 'workspace', contributor: 'member', chain: 'chain' }, repository_id: 'repository' }, action } });
const context = (controller = new AbortController(), viewKind = 'sidebar') => ({ signal: controller.signal, session: Math.random().toString(), viewKind });

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-repository-host-'));
  const bin = path.join(directory, 'bin', `${process.platform}-${process.arch}`);
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, `idle-repository${process.platform === 'win32' ? '.exe' : ''}`), '');
  f.context.extensionUri = uri(`file://${directory}`);
  const children = [];
  t.mock.method(childProcess, 'spawn', (binary, args, options) => {
    const child = fakeChild();
    Object.assign(child, { requests: [], binary, args, options });
    const decoder = new FrameDecoder(64 * 1024 * 1024);
    const write = child.stdin.write;
    child.stdin.write = (bytes, callback) => {
      const accepted = write(bytes, callback);
      for (const frame of decoder.push(bytes)) child.requests.push(JSON.parse(frame));
      return accepted;
    };
    children.push(child);
    return child;
  });
  let session = { account: { id: 'one', label: 'One' }, accessToken: 'private-token-one' };
  const configuration = new HostConfiguration(directory);
  const host = new RepositoryHost(f.context, configuration, { repositorySession: async () => session }, async () => 'member');
  const config = configuration.forResource(f.api.workspace.workspaceFolders[0].uri);
  const result = (value = 'read', scope = binding) => ({ repository: { scope, value }, projections: [] });
  const reply = (child = children.at(-1), value, scope) => child.reply({ id: child.requests.at(-1).id, body: { Ok: result(value, scope) } });
  t.after(async () => { await host.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  return { host, config, children, reply, result, setSession: value => { session = value; } };
}

test('two views share one read and closing one promptly cancels only its waiter', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const a = new AbortController();
  const first = h.host.snapshot(h.config, binding, a.signal);
  const second = h.host.snapshot(h.config, binding, new AbortController().signal);
  const cancelled = assert.rejects(first, { code: 'cancelled' });
  await tick();
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].requests.length, 1);
  a.abort();
  await cancelled;
  assert.deepEqual(h.children[0].signals, []);
  h.reply();
  assert.deepEqual(await second, h.result());
  assert.deepEqual(await h.host.snapshot(h.config, binding, new AbortController().signal), h.result());
  assert.equal(h.children[0].requests.length, 1, 'projection reuses the recent bound snapshot');
});

test('manual projection refresh bypasses recent results and revalidates GitHub', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const effects = new HostEffects(() => true);
  const installed = [];
  const history = {
    connect(value) { installed.push(value.repository); return { dispose() {} }; },
    async projection(params, signal, inputs) { return inputs; },
  };
  const assembly = new AssemblyHost(new HostConfiguration('/extension'), history, effects,
    (_folder, error) => assert.fail(String(error)), undefined, h.host);
  t.after(() => { assembly.dispose(); effects.dispose(); });
  await effects.execute('app.workspace', { operation: 'List' }, context());
  const selected = installed[0];
  const params = refresh_sources => ({ binding: selected, operation: { refresh_sources } });
  const initial = effects.execute('app.projection', params(false), context());
  await tick();
  h.reply(undefined, 'initial', selected);
  await initial;
  await effects.execute('app.projection', params(false), context());
  assert.equal(h.children[0].requests.length, 1, 'automatic updates can share recent results');
  const manual = effects.execute('app.projection', params(true), context());
  await tick();
  assert.equal(h.children[0].requests.length, 2, 'manual refresh bypasses the host cache');
  assert.equal(h.children[0].requests[1].body.refresh_github, true, 'manual refresh reaches the native GitHub reader');
  h.reply(undefined, 'refreshed', selected);
  await manual;
});

test('closing the last waiter stops the reader and a later view starts a new one', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const controller = new AbortController();
  const pending = assert.rejects(h.host.snapshot(h.config, binding, controller.signal), { code: 'cancelled' });
  await tick();
  controller.abort();
  await pending;
  assert.deepEqual(h.children[0].signals, ['SIGTERM']);
  const next = h.host.snapshot(h.config, binding, new AbortController().signal);
  await tick();
  assert.equal(h.children.length, 2);
  h.reply();
  await next;
});

test('account replacement retires the old read and keeps tokens out of arguments', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const old = assert.rejects(h.host.snapshot(h.config, binding, new AbortController().signal));
  await tick();
  assert(!JSON.stringify([h.children[0].args, h.children[0].options]).includes('private-token-one'));
  assert.equal(h.children[0].requests[0].body.credentials.token, 'private-token-one');
  h.setSession({ account: { id: 'two', label: 'Two' }, accessToken: 'private-token-two' });
  const current = h.host.snapshot(h.config, binding, new AbortController().signal);
  await tick();
  await old;
  assert.equal(h.children.length, 2);
  h.reply(h.children[0], 'retired');
  h.reply(h.children[1], 'current');
  assert.equal((await current).repository.value, 'current');
});

test('explicit refresh arriving during a poll revalidates GitHub after the shared read', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const poll = h.host.read(h.config, binding, operation('Poll'), context());
  const refresh = h.host.read(h.config, binding, operation('Read'), context());
  await tick();
  assert.equal(h.children[0].requests[0].body.refresh_github, false);
  h.reply();
  await poll;
  await tick();
  assert.equal(h.children[0].requests.length, 2);
  assert.equal(h.children[0].requests[1].body.refresh_github, true);
  h.reply();
  await refresh;
});

test('session preferences finish after view closure and remain separate by surface', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const selected = 'ab'.repeat(32);
  const controller = new AbortController();
  const saved = h.host.read(h.config, binding, operation({ Remember: selected }), context(controller));
  await tick();
  controller.abort();
  assert.deepEqual(await saved, { Ok: 'Remembered' });
  const sidebar = h.host.read(h.config, binding, operation('Read'), context());
  await tick(); h.reply();
  assert.equal((await sidebar).Ok.Snapshot.selected_session, selected);
  const detail = h.host.read(h.config, binding, operation('Read'), context(undefined, 'detail'));
  await tick(); h.reply();
  assert.equal((await detail).Ok.Snapshot.selected_session, null);
});

test('foreign bindings and malformed native replacements never become current', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const params = operation('Read');
  params.operation.context.connection.contributor = 'different';
  await assert.rejects(h.host.read(h.config, binding, params, context()), { code: 'binding_mismatch' });
  assert.equal(h.children.length, 0);
  const pending = assert.rejects(h.host.snapshot(h.config, binding, new AbortController().signal), { code: 'invalid_response' });
  await tick();
  const child = h.children[0];
  child.reply({ id: child.requests[0].id, body: { Ok: { repository: { scope: { ...binding, chain: 'foreign' } }, projections: [] } } });
  await pending;
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('reset during a read rejects the continuation and does not reuse retired results', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const pending = assert.rejects(h.host.snapshot(h.config, binding, new AbortController().signal));
  await tick();
  h.host.reset();
  await pending;
  const current = h.host.snapshot(h.config, binding, new AbortController().signal);
  await tick(); h.reply(); await current;
  assert.equal(h.children.length, 2);
});
