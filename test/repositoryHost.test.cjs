const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fixture, loadWithVSCode, uri } = require('./helpers/vscode.cjs');
const { harness: nativeHarness } = require('./fixtures/native-host-fake.cjs');
const { HostEffects } = require('../out/host/effects');
const f = fixture();
const { HostConfiguration } = loadWithVSCode('../../out/host/configuration', f.api);
const { RepositoryHost } = loadWithVSCode('../../out/host/repository', f.api);
const { AssemblyHost } = loadWithVSCode('../../out/host/assembly', f.api);
const tick = () => new Promise(resolve => setImmediate(resolve));
const binding = { workspace_id: 'workspace', repository_id: 'repository', chain: 'chain' };
const operation = action => ({ operation: { context: { connection: { provider: 'idle-local', workspace: 'workspace', contributor: 'member', chain: 'chain' }, repository_id: 'repository' }, action } });
const context = (controller = new AbortController(), viewKind = 'sidebar') => ({ signal: controller.signal, session: Math.random().toString(), viewKind });
const sessionSnapshot = (state = 'complete', topic = 'history.sessions') => ({ repository: { scope: binding,
  sessions: state === 'complete' ? [{ id: 'ab'.repeat(32), labels: ['Recorded session'] }] : [],
  reports: [{ topic, state, message: 'Recorded session read', checked_at_ms: 1, retry_at_ms: null, source_url: null }],
}, projections: [] });

async function harness(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-repository-host-'));
  f.context.extensionUri = uri(`file://${directory}`);
  const { host: native, processes, channels } = nativeHarness(t, options);
  let session = { account: { id: 'one', label: 'One' }, accessToken: 'private-token-one' };
  const configuration = new HostConfiguration(directory);
  const host = new RepositoryHost(f.context, configuration, { repositorySession: async () => session }, async () => 'member', native);
  const config = configuration.forResource(f.api.workspace.workspaceFolders[0].uri);
  const result = (value = 'read', scope = binding) => ({ repository: { scope, value }, projections: [] });
  const reply = (child = channels.at(-1), value, scope) => child.reply({ id: child.requests.at(-1).id, body: { Ok: result(value, scope) } });
  t.after(async () => { await host.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  return { host, config, channels, processes, reply, result, setSession: value => { session = value; } };
}

test('two views share one read and closing one promptly cancels only its waiter', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const a = new AbortController();
  const first = h.host.snapshot(h.config, binding, a.signal);
  const second = h.host.snapshot(h.config, binding, new AbortController().signal);
  const cancelled = assert.rejects(first, { code: 'cancelled' });
  await tick();
  assert.equal(h.channels.length, 1);
  assert.equal(h.channels[0].requests.length, 1);
  a.abort();
  await cancelled;
  assert.deepEqual(h.processes[0].signals, []);
  h.reply();
  assert.deepEqual(await second, h.result());
  assert.deepEqual(await h.host.snapshot(h.config, binding, new AbortController().signal), h.result());
  assert.equal(h.channels[0].requests.length, 1, 'projection reuses the recent bound snapshot');
});

test('initial local sessions are independent of a delayed GitHub read and the follow-up shares that read', { timeout: 5000 }, async t => {
  const h = await harness(t, { features: ['repository.local'] });
  const remote = h.host.snapshot(h.config, binding, new AbortController().signal);
  await tick();
  const initial = h.host.read(h.config, binding, { ...operation('Read'), initial: true }, context());
  await tick();
  assert.equal(h.channels.length, 2, 'local records use an independent service channel');
  const local = h.channels.find(channel => channel.requests[0].body.local_only);
  assert.equal(local.requests[0].body.credentials, null, 'local reads do not acquire repository credentials');
  h.reply(local, 'local sessions');
  assert.equal((await initial).local.Ok.Snapshot.snapshot.value, 'local sessions');
  const poll = h.host.read(h.config, binding, operation('Poll'), context());
  await tick();
  assert.equal(h.channels[0].requests.length, 1, 'background completion joins the existing projection read');
  h.reply(h.channels[0], 'GitHub and local');
  await remote;
  assert.equal((await poll).Ok.Snapshot.snapshot.value, 'GitHub and local');
  const refresh = h.host.read(h.config, binding, operation('Read'), context());
  await tick();
  assert.equal(h.channels[0].requests.at(-1).body.refresh_github, true);
  h.reply(h.channels[0], 'explicit refresh');
  await refresh;
});

for (const local of [false, true]) test(`${local ? 'local' : 'full'} repository reads recover session contention without another GitHub refresh`, { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(t, { features: ['repository.local'] });
  const mode = local ? 'local' : 'refresh';
  const first = h.host.snapshot(h.config, binding, new AbortController().signal, mode);
  const second = h.host.snapshot(h.config, binding, new AbortController().signal, mode);
  await tick();
  const channel = h.channels[0];
  assert.equal(channel.requests.length, 1);
  channel.reply({ id: channel.requests[0].id, body: { Ok: sessionSnapshot('unavailable') } });
  await tick();
  t.mock.timers.tick(25);
  await tick();
  assert.equal(channel.requests.length, 2, 'both views share the recovery read');
  assert.deepEqual(channel.requests[1].body, { ...channel.requests[0].body, refresh_github: false });
  const expected = local ? { ...sessionSnapshot(), local: true } : sessionSnapshot();
  channel.reply({ id: channel.requests[1].id, body: { Ok: sessionSnapshot() } });
  assert.deepEqual(await Promise.all([first, second]), [expected, expected]);
  assert.deepEqual(await h.host.snapshot(h.config, binding, new AbortController().signal, local ? 'local' : 'projection'), expected);
  assert.equal(channel.requests.length, 2, 'only the recovered snapshot is cached');
});

test('persistent session failures retain their source report after bounded retries', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(t);
  const pending = h.host.snapshot(h.config, binding, new AbortController().signal);
  await tick();
  const channel = h.channels[0];
  const unavailable = sessionSnapshot('unavailable');
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(channel.requests.length, attempt + 1);
    channel.reply({ id: channel.requests.at(-1).id, body: { Ok: unavailable } });
    await tick();
    t.mock.timers.tick(1000);
    await tick();
  }
  assert.deepEqual(await pending, unavailable);
  assert.equal(channel.requests.length, 4);
});

test('empty, partial and unrelated source reports do not trigger session retries', { timeout: 5000 }, async t => {
  for (const [state, topic] of [['complete', 'history.sessions'], ['partial', 'history.sessions'], ['unavailable', 'github.issues']]) {
    const h = await harness(t);
    const pending = h.host.snapshot(h.config, binding, new AbortController().signal);
    await tick();
    const result = sessionSnapshot(state, topic);
    result.repository.sessions = [];
    const channel = h.channels[0];
    channel.reply({ id: channel.requests[0].id, body: { Ok: result } });
    assert.deepEqual(await pending, result);
    assert.equal(channel.requests.length, 1);
  }
});

for (const reason of ['abort', 'reset']) test(`session recovery stops after ${reason} and does not read a retired binding`, { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(t);
  const abort = new AbortController();
  const rejected = assert.rejects(h.host.snapshot(h.config, binding, abort.signal), { code: 'cancelled' });
  await tick();
  const channel = h.channels[0];
  channel.reply({ id: channel.requests[0].id, body: { Ok: sessionSnapshot('unavailable') } });
  await tick();
  if (reason === 'abort') abort.abort(); else h.host.reset();
  t.mock.timers.tick(1000);
  await rejected;
  await tick();
  assert.equal(channel.requests.length, 1);
  assert.equal(channel.closed, true);
});

test('older native hosts keep the original read protocol and share concurrent startup reads', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const params = { ...operation('Read'), initial: true };
  const first = h.host.read(h.config, binding, params, context());
  const second = h.host.read(h.config, binding, params, context());
  await tick();
  const channel = h.channels.find(value => value.requests.length);
  assert.equal(channel.requests.length, 1);
  assert.deepEqual(Object.keys(channel.requests[0].body).sort(), ['credentials', 'refresh_github']);
  h.reply(channel, 'legacy');
  const replies = await Promise.all([first, second]);
  assert.ok(replies.every(value => !value.local && value.Ok.Snapshot.snapshot.value === 'legacy'));
});

test('reset retires both startup channels and a late local result cannot update the new workspace', { timeout: 5000 }, async t => {
  const h = await harness(t, { features: ['repository.local'] });
  const params = { ...operation('Read'), initial: true };
  const local = assert.rejects(h.host.read(h.config, binding, params, context()));
  const remote = assert.rejects(h.host.snapshot(h.config, binding, new AbortController().signal));
  await tick();
  const retired = [...h.channels];
  h.host.reset();
  await Promise.all([local, remote]);
  assert.ok(retired.every(channel => channel.closed));
  const fresh = h.host.read(h.config, binding, params, context());
  await tick();
  for (const channel of retired) h.reply(channel, 'retired');
  h.reply(undefined, 'current local');
  assert.equal((await fresh).local.Ok.Snapshot.snapshot.value, 'current local');
});

test('history invalidation rereads local sessions even when a complete snapshot was just cached', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const first = h.host.snapshot(h.config, binding, new AbortController().signal);
  await tick(); h.reply(undefined, 'before capture'); await first;
  const changed = h.host.read(h.config, binding, operation('Poll'), context());
  await tick();
  assert.equal(h.channels[0].requests.length, 2, 'recent remote results cannot hide a new local session');
  assert.equal(h.channels[0].requests[1].body.refresh_github, false, 'local changes retain the native GitHub cache policy');
  h.reply(undefined, 'new session');
  assert.equal((await changed).Ok.Snapshot.snapshot.value, 'new session');
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
  assert.equal(h.channels[0].requests.length, 1, 'automatic updates can share recent results');
  const manual = effects.execute('app.projection', params(true), context());
  await tick();
  assert.equal(h.channels[0].requests.length, 2, 'manual refresh bypasses the host cache');
  assert.equal(h.channels[0].requests[1].body.refresh_github, true, 'manual refresh reaches the native GitHub reader');
  h.reply(undefined, 'refreshed', selected);
  await manual;
});

test('initial Activity uses local records while a complete projection read remains pending', { timeout: 5000 }, async t => {
  const h = await harness(t, { features: ['repository.local'] });
  const effects = new HostEffects(() => true);
  const installed = [];
  const history = {
    connect(value) { installed.push(value.repository); return { dispose() {} }; },
    async projection() { return { Ok: 'Activity from local history' }; },
  };
  const assembly = new AssemblyHost(new HostConfiguration('/extension'), history, effects,
    (_folder, error) => assert.fail(String(error)), undefined, h.host);
  t.after(() => { assembly.dispose(); effects.dispose(); });
  await effects.execute('app.workspace', { operation: 'List' }, context());
  const selected = installed[0];
  const remote = h.host.snapshot(h.config, selected, new AbortController().signal);
  await tick();
  const params = { binding: selected, operation: { refresh_sources: false } };
  const initial = effects.execute('app.projection', { ...params, initial: true }, context());
  await tick();
  const local = h.channels.find(channel => channel.requests[0].body.local_only);
  h.reply(local, 'local', selected);
  assert.deepEqual(await initial, { local: { Ok: 'Activity from local history' } });
  const complete = effects.execute('app.projection', { ...params, initial: false }, context());
  await tick();
  assert.equal(h.channels[0].requests.length, 1, 'remote completion shares the pending read');
  h.reply(h.channels[0], 'complete', selected);
  await remote;
  assert.deepEqual(await complete, { Ok: 'Activity from local history' });
});

test('closing the last waiter stops the reader and a later view starts a new one', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const controller = new AbortController();
  const pending = assert.rejects(h.host.snapshot(h.config, binding, controller.signal), { code: 'cancelled' });
  await tick();
  controller.abort();
  await pending;
  await tick();
  assert.equal(h.channels[0].closed, true);
  assert.deepEqual(h.processes[0].signals, [], 'the shared process continues after channel retirement');
  const next = h.host.snapshot(h.config, binding, new AbortController().signal);
  await tick();
  assert.equal(h.channels.length, 2);
  h.reply();
  await next;
});

test('account replacement retires the old read and keeps tokens out of arguments', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const old = assert.rejects(h.host.snapshot(h.config, binding, new AbortController().signal));
  await tick();
  assert(!JSON.stringify([h.processes[0].args, h.processes[0].options, h.channels[0].installation]).includes('private-token-one'));
  assert.equal(h.channels[0].requests[0].body.credentials.token, 'private-token-one');
  h.setSession({ account: { id: 'two', label: 'Two' }, accessToken: 'private-token-two' });
  const current = h.host.snapshot(h.config, binding, new AbortController().signal);
  await tick();
  await old;
  assert.equal(h.channels.length, 2);
  h.reply(h.channels[0], 'retired');
  h.reply(h.channels[1], 'current');
  assert.equal((await current).repository.value, 'current');
});

test('explicit refresh arriving during a poll revalidates GitHub after the shared read', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const poll = h.host.read(h.config, binding, operation('Poll'), context());
  const refresh = h.host.read(h.config, binding, operation('Read'), context());
  await tick();
  assert.equal(h.channels[0].requests[0].body.refresh_github, false);
  h.reply();
  await poll;
  await tick();
  assert.equal(h.channels[0].requests.length, 2);
  assert.equal(h.channels[0].requests[1].body.refresh_github, true);
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
  assert.equal(h.channels.length, 0);
  const pending = assert.rejects(h.host.snapshot(h.config, binding, new AbortController().signal), { code: 'invalid_response' });
  await tick();
  const child = h.channels[0];
  child.reply({ id: child.requests[0].id, body: { Ok: { repository: { scope: { ...binding, chain: 'foreign' } }, projections: [] } } });
  await pending;
  await tick();
  assert.equal(child.closed, true);
  assert.deepEqual(h.processes[0].signals, []);
});

test('reset during a read rejects the continuation and does not reuse retired results', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const pending = assert.rejects(h.host.snapshot(h.config, binding, new AbortController().signal));
  await tick();
  h.host.reset();
  await pending;
  const current = h.host.snapshot(h.config, binding, new AbortController().signal);
  await tick(); h.reply(); await current;
  assert.equal(h.channels.length, 2);
});
