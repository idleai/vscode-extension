const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadWithVSCode } = require('./helpers/vscode.cjs');

const f = fixture();
const { SessionHost } = loadWithVSCode('../../out/host/sessions', f.api);
const { HostError } = loadWithVSCode('../../out/host/protocol', f.api);
const binding = { workspace_id: 'workspace', repository_id: 'repository', chain: 'chain' };
const context = { signal: new AbortController().signal, session: 'detail-one' };
const scope = contributor => ({ provider: 'idle-local', mode: 'Standalone', workspace_id: 'workspace', chain: 'chain', contributor_id: contributor });

function input(contributor = 'alice', id = 'prompt-one', text = 'Exact task\nSecond line') {
  const author = { contributor_id: contributor, issuer: 'idle-runtime-grant', subject: contributor };
  const mutation = { request_id: id, expires_at_ms: 4000 };
  return {
    operation: { context: scope(contributor), action: { Mutate: {
      request: { workspace_id: 'workspace', contributor: author, mutation },
      mutation: { Submit: { session_id: 'runner-one', text } },
    } } },
    command: JSON.stringify({ kind: 'submit', request: { api_version: '1', control_fence: null,
      context: { workspace_id: 'workspace', contributor: { contributor_id: contributor,
        authenticated_as: { issuer: 'idle-runtime-grant', subject: contributor } }, request_id: id, expires_at: '4000' },
      body: { session_id: 'runner-one', text } } }),
  };
}

test('a lost reply retains the exact request across editor restart without resending on load', async () => {
  const storage = fixture().context.globalState;
  let calls = 0;
  const runtime = { async session(_config, _binding, command) {
    calls++;
    const saved = storage.get(storage.keys()[0]);
    assert.equal(saved.requests[0].command, command, 'persist before transport');
    if (calls === 1) throw new Error('reply lost after acceptance');
    return { kind: 'input', update: { order: 1 } };
  } };
  const make = () => new SessionHost(storage, { assertTrusted() {} }, runtime, async () => 'alice');
  const first = make();
  const payload = input();
  await assert.rejects(first.call({}, binding, payload, context), /reply lost/);
  await first.shutdown();
  const reopened = make();
  const saved = await reopened.state(binding, { context: scope('alice'), action: 'load' }, context);
  assert.deepEqual(saved.requests, [payload.operation]);
  assert.equal(calls, 1, 'load performs no runtime calls');
  assert.deepEqual(await reopened.call({}, binding, payload, context), { session: { kind: 'input', update: { order: 1 } }, changed: true });
  await assert.rejects(reopened.call({}, binding, input('alice', 'prompt-one', 'Changed task'), context), { code: 'conflict' });
  assert.equal(calls, 2, 'changed payload never reaches the runtime');
  await reopened.shutdown();
});

test('drafts and pending writes stay isolated by contributor and workspace', async () => {
  const storage = fixture().context.globalState;
  let contributor = 'alice';
  const host = new SessionHost(storage, { assertTrusted() {} }, { session: async () => ({ kind: 'input' }) }, async () => contributor);
  const drafts = JSON.stringify({ prompts: { 'runner-one': { text: 'Unsent Alice draft' } } });
  await host.state(binding, { context: scope('alice'), action: 'store', drafts, settled: [] }, context);
  await host.call({}, binding, input(), context);
  contributor = 'bob';
  const bob = await host.state(binding, { context: scope('bob'), action: 'load' }, context);
  assert.deepEqual(bob, { drafts: '{}', requests: [] });
  await assert.rejects(host.call({}, binding, input(), context), { code: 'denied' });
  contributor = 'alice';
  const other = { ...binding, workspace_id: 'other-workspace' };
  const foreign = await host.state(other, { context: { ...scope('alice'), workspace_id: 'other-workspace' }, action: 'load' }, context);
  assert.deepEqual(foreign.requests, []);
  const original = await host.state(binding, { context: scope('alice'), action: 'load' }, context);
  assert.equal(original.drafts, drafts);
  assert.equal(original.requests.length, 1);
  await host.shutdown();
});

test('confirmed results clear only their requests while the next draft is saved atomically', async () => {
  const storage = fixture().context.globalState;
  const host = new SessionHost(storage, { assertTrusted() {} }, { session: async () => ({ kind: 'input' }) }, async () => 'alice');
  await Promise.all([host.call({}, binding, input('alice', 'first'), context), host.call({}, binding, input('alice', 'second'), context)]);
  const drafts = JSON.stringify({ prompts: { 'runner-one': { text: 'Next task' } } });
  await host.state(binding, { context: scope('alice'), action: 'store', drafts, settled: ['first'] }, context);
  const restored = await host.state(binding, { context: scope('alice'), action: 'load' }, context);
  assert.equal(restored.requests.length, 1);
  assert.equal(restored.requests[0].action.Mutate.request.mutation.request_id, 'second');
  assert.equal(restored.drafts, drafts);
  await host.shutdown();
});

test('storage failure stops a new task before the runtime receives it', async () => {
  const storage = fixture().context.globalState;
  storage.update = async () => { throw new Error('storage full'); };
  let called = false;
  const host = new SessionHost(storage, { assertTrusted() {} }, { session: async () => { called = true; } }, async () => 'alice');
  await assert.rejects(host.call({}, binding, input(), context), /storage full/);
  assert.equal(called, false);
  await host.shutdown();
});

test('the transmitted prompt must match the saved editor intent before dispatch', async () => {
  const storage = fixture().context.globalState;
  let calls = 0;
  const host = new SessionHost(storage, { assertTrusted() {} }, { async session() { calls++; } }, async () => 'alice');
  const payload = input();
  const command = JSON.parse(payload.command);
  command.request.body.text = 'A different task';
  payload.command = JSON.stringify(command);
  await assert.rejects(host.call({}, binding, payload, context), { code: 'denied' });
  assert.equal(calls, 0);
  const saved = await host.state(binding, { context: scope('alice'), action: 'load' }, context);
  assert.deepEqual(saved.requests, []);
  await host.shutdown();
});

test('a disconnected session read is a typed state while uncertain writes retain their request', async () => {
  const storage = fixture().context.globalState;
  const runtime = { async session() { throw new HostError('unavailable', 'Connect a runner invitation.'); } };
  const host = new SessionHost(storage, { assertTrusted() {} }, runtime, async () => 'alice');
  const operation = { context: scope('alice'), action: 'Snapshot' };
  assert.deepEqual(await host.call({}, binding, { operation, command: '{"kind":"snapshot"}' }, context),
    { session: { error: { code: 'disconnected' } }, changed: false });
  await assert.rejects(host.call({}, binding, input(), context), { code: 'unavailable' });
  const saved = await host.state(binding, { context: scope('alice'), action: 'load' }, context);
  assert.equal(saved.requests.length, 1);
  await host.shutdown();
});
