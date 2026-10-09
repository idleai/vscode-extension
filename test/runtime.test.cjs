const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadWithVSCode } = require('./helpers/vscode.cjs');
const { harness } = require('./fixtures/native-host-fake.cjs');

const f = fixture();
const { RuntimeHost } = loadWithVSCode('../../out/host/runtime', f.api);
const binding = { workspace_id: 'workspace-one', repository_id: 'repository-one', chain: 'chain-one' };
const config = { cwd: '/workspace' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const status = { protocolVersion: 1, hostId: 'host-one', hostName: 'compute-machine', runtimeId: 'runtime-one',
  capabilities: ['workspaceAttachment', 'workspaceStatus'], workspaces: [{ binding: {
    workspaceId: binding.workspace_id, repositoryId: binding.repository_id, chainId: binding.chain,
    checkoutId: 'checkout-one', checkoutRoot: '/compute/workspace', chainDirectory: '/compute/chain',
  }, available: true }] };

function setup(t, request) {
  const context = fixture().context;
  const configuration = { assertTrusted() { if (!f.api.workspace.isTrusted) throw new Error('untrusted'); } };
  const native = harness(t, { features: ['runtime.workspace'], request: request ?? ((channel, call) => {
    if (call.kind === 'call') channel.reply({ version: 1, id: call.data.id, result: { Ok: { status } } });
  }) });
  const runtime = new RuntimeHost(context, configuration, native.host, async () => 'client-one');
  t.after(() => runtime.shutdown());
  return { runtime, native, context };
}

test('pairing stores the invitation privately and sends the exact workspace binding', async t => {
  const { runtime, native, context } = setup(t);
  assert.equal(await runtime.snapshot(config, binding), undefined);
  assert.equal(native.channels.length, 0);
  const request = JSON.parse(await runtime.connectionRequest(binding));
  assert.deepEqual(request, { version: 1, workspaceId: 'workspace-one', repositoryId: 'repository-one',
    chainId: 'chain-one', clientId: 'client-one' });
  await runtime.connect(config, binding, 'idle-runtime:PRIVATE');
  const installation = native.channels[0].installation;
  assert.equal(installation.service.kind, 'runtime');
  assert.deepEqual(installation.service.binding, { invitation: 'idle-runtime:PRIVATE',
    workspace_id: 'workspace-one', repository_id: 'repository-one', chain_id: 'chain-one', client_id: 'client-one' });
  const observation = await runtime.snapshot(config, binding);
  assert.equal(observation.connected, true);
  assert.equal(observation.status.hostId, 'host-one');
  assert.ok(!JSON.stringify(observation).includes('PRIVATE'));
  assert.equal(native.channels[0].requests.length, 1, 'views share the last fresh status read');
  const [key] = context.globalState.keys();
  assert.ok(!JSON.stringify(context.globalState.get(key)).includes('PRIVATE'));
  assert.equal(await context.secrets.get(key.replace(/\.status$/, '')), 'idle-runtime:PRIVATE');
  await runtime.disconnect(binding);
  assert.equal(await runtime.snapshot(config, binding), undefined);
  assert.ok(native.channels[0].closed);
  assert.deepEqual(native.channels[0].requests.filter(call => call.kind === 'call').map(call => call.data.command.kind), ['status']);
});

test('revoked access keeps the host visible as unavailable', async t => {
  let now = Date.now(), denied = false;
  t.mock.method(Date, 'now', () => now);
  const { runtime } = setup(t, (channel, call) => {
    if (call.kind === 'call') channel.reply({ version: 1, id: call.data.id,
      result: denied ? { Err: 'forbidden' } : { Ok: { status } } });
  });
  await runtime.connect(config, binding, 'idle-runtime:PRIVATE');
  now += 11_000; denied = true;
  const observation = await runtime.snapshot(config, binding);
  assert.equal(observation.connected, false);
  assert.equal(observation.status.hostId, 'host-one');
  assert.equal(observation.observed_at, now);
});

test('connection updates in the same millisecond have distinct revisions', async t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let denied = false;
  const { runtime } = setup(t, (channel, call) => {
    if (call.kind === 'call') channel.reply({ version: 1, id: call.data.id,
      result: denied ? { Err: 'forbidden' } : { Ok: { status } } });
  });
  await runtime.connect(config, binding, 'idle-runtime:PRIVATE');
  const before = await runtime.snapshot(config, binding);
  await runtime.reset();
  denied = true;
  const after = await runtime.snapshot(config, binding);
  assert.equal(after.connected, false);
  assert.equal(after.observed_at, before.observed_at);
  assert.ok(after.revision > before.revision, 'status revisions survive connection resets');
});

test('a failed replacement does not erase the working invitation', async t => {
  const { runtime, context } = setup(t, (channel, call) => {
    if (call.kind !== 'call') return;
    channel.reply({ version: 1, id: call.data.id, result: channel.installation.service.binding.invitation.endsWith('BAD')
      ? { Err: 'forbidden' } : { Ok: { status } } });
  });
  await runtime.connect(config, binding, 'idle-runtime:PRIVATE');
  await assert.rejects(runtime.connect(config, binding, 'idle-runtime:BAD'));
  assert.equal((await runtime.snapshot(config, binding)).connected, true);
  const [key] = context.globalState.keys();
  assert.equal(await context.secrets.get(key.replace(/\.status$/, '')), 'idle-runtime:PRIVATE');
});

test('a native host restart reconnects using the saved scope', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { runtime, native } = setup(t);
  await runtime.connect(config, binding, 'idle-runtime:PRIVATE');
  const child = native.processes[0];
  child.emit('exit', 1); child.emit('close');
  now += 11_000;
  const observation = await runtime.snapshot(config, binding);
  assert.equal(observation.connected, true);
  assert.equal(native.processes.length, 2);
  assert.equal(native.channels[1].installation.service.binding.workspace_id, binding.workspace_id);
});

test('workspace reset retires a pairing response still in flight', async t => {
  let pending;
  const { runtime, native, context } = setup(t, (channel, call) => { if (call.kind === 'call') pending = { channel, call }; });
  const work = runtime.connect(config, binding, 'idle-runtime:PRIVATE');
  const rejected = assert.rejects(work, { code: 'cancelled' });
  while (!pending) await tick();
  await runtime.reset();
  pending.channel.reply({ version: 1, id: pending.call.data.id, result: { Ok: { status } } });
  await rejected;
  assert.equal(context.globalState.keys().length, 0);
  assert.ok(native.channels[0].closed);
});
