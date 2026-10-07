const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, services } = require('./fixtures/native-host-fake.cjs');
const { StdioClient } = require('../out/host/processes');
const { CoordinationClient } = require('../out/host/coordinationClient');
const tick = () => new Promise(resolve => setImmediate(resolve));
const client = (host, workspace = '/workspace', kind = 'history') => new StdioClient({}, host.connection(workspace, kind, {}));

test('optional features wait for the handshake and cannot survive a host replacement', async t => {
  const h = harness(t, { manualHello: true });
  const a = client(h.host);
  a.start();
  let settled = false;
  const supported = h.host.supports('repository.local').then(value => { settled = true; return value; });
  await tick();
  assert.equal(settled, false);
  h.processes[0].hello(services, ['repository.local']);
  assert.equal(await supported, true);
  assert.equal(await h.host.supports('unknown.feature'), false);
  await h.host.restart();
  assert.equal(await h.host.supports('repository.local'), false);
  a.start();
  await tick();
  h.processes[1].hello();
  assert.equal(await h.host.supports('repository.local'), false, 'an older replacement has no optional operations');
});

test('multiple services and workspaces share one process and close independently', async t => {
  const h = harness(t, { request: (channel, request) => channel.reply({ id: request.id, body: request.body }) });
  const a = client(h.host, '/first'), b = client(h.host, '/second', 'capture');
  a.start(); b.start();
  assert.deepEqual(await Promise.all([a.request({ first: true }), b.request({ second: true })]), [{ first: true }, { second: true }]);
  assert.equal(h.processes.length, 1);
  assert.deepEqual(h.processes[0].args, [], 'workspace configuration uses the private pipe');
  assert.equal(h.processes[0].options.cwd, undefined, 'the process never borrows one workspace as a global working directory');
  assert.deepEqual(h.channels.map(channel => channel.installation.workspace), ['/first', '/second']);
  await a.shutdown();
  assert.equal(h.channels[0].closed, true);
  assert.deepEqual(h.processes[0].signals, [], 'closing one channel does not signal the process');
  assert.deepEqual(await b.request({ still: 'running' }), { still: 'running' });
  await b.shutdown();
  await h.host.shutdown();
  assert.deepEqual(h.processes[0].signals, ['SIGTERM']);
});

test('requests wait for an enforced service handshake', async t => {
  const h = harness(t, { manualHello: true });
  const a = client(h.host);
  a.start();
  const pending = assert.rejects(a.request({ read: true }));
  await tick();
  assert.equal(h.channels.length, 0, 'no binding is sent before compatibility is established');
  h.processes[0].hello({ ...services, history: 2 });
  await pending;
  assert.equal(h.channels.length, 0);
  assert.equal(a.isRunning(), false);
});

test('a malformed service reply retires only that service', async t => {
  const h = harness(t);
  const a = client(h.host, '/first'), b = client(h.host, '/second');
  a.start(); b.start();
  const failed = assert.rejects(a.request({ first: true }));
  const second = b.request({ second: true });
  await tick();
  h.channels[0].replyRaw('invalid JSON');
  await failed;
  h.channels[1].reply({ id: 1, body: 'usable' });
  assert.equal(await second, 'usable');
  assert.deepEqual(h.processes[0].signals, []);
});

test('exact request bytes and full Rust integers survive the routing header', async t => {
  const h = harness(t);
  const a = client(h.host, '/capture', 'capture');
  a.start();
  const source = Buffer.from('{ "sequence":18446744073709551615,"text":"😀\\r\\n" }');
  const pending = a.requestJson(source);
  await tick();
  assert.deepEqual(h.channels[0].raw[0], Buffer.concat([Buffer.from('{"id":1,"body":'), source, Buffer.from('}')]));
  h.channels[0].reply({ id: 1, body: 'recorded' });
  await pending;
  const coordination = new CoordinationClient({}, undefined, h.host.connection('/capture', 'coordination', {}));
  coordination.start();
  const response = coordination.request('{"kind":"snapshot"}');
  await tick();
  const raw = '{"version":1,"id":"1","result":{"Ok":{"cursor":18446744073709551615}}}';
  h.channels[1].replyRaw(raw);
  assert.equal(await response, raw, 'the Rust payload is forwarded without JSON reserialization');
  await coordination.shutdown();
});

test('credential replies stay attached to their coordinator channel', async t => {
  const h = harness(t);
  const first = new CoordinationClient({}, async () => 'first-token', h.host.connection('/first', 'coordination', {}));
  const second = new CoordinationClient({}, async () => 'second-token', h.host.connection('/second', 'coordination', {}));
  first.start(); second.start();
  await tick();
  for (const channel of h.channels) channel.reply({ kind: 'credential', data: { id: 'same-id', purpose: 'management' } });
  await tick();
  assert.deepEqual(h.channels.map(channel => channel.requests[0].data.token), ['first-token', 'second-token']);
  assert(!JSON.stringify(h.processes[0].args).includes('token'));
  await Promise.all([first.shutdown(), second.shutdown()]);
});

test('retired credential callbacks cannot use a still-running shared host', async t => {
  const h = harness(t);
  let provide;
  const token = new Promise(resolve => { provide = resolve; });
  const first = new CoordinationClient({}, () => token, h.host.connection('/first', 'coordination', {}));
  const second = client(h.host, '/second');
  first.start(); second.start(); await tick();
  h.channels[0].reply({ kind: 'credential', data: { id: 'pending', purpose: 'management' } });
  await first.shutdown();
  provide('retired-token'); await tick();
  assert.deepEqual(h.channels[0].requests, [], 'a late credential is never written onto the shared pipe');
  assert.equal(second.isRunning(), true);
  assert.deepEqual(h.processes[0].signals, []);
});

test('a crashed host rejects all services and waits for OS exit before replacement', async t => {
  const h = harness(t, { ignoresTerm: true });
  const a = client(h.host), b = client(h.host, '/second');
  a.start(); b.start();
  const pending = [assert.rejects(a.request('first')), assert.rejects(b.request('second'))];
  await tick();
  h.processes[0].stdout.emit('end');
  await Promise.all(pending);
  a.start();
  const replacement = a.request('replacement');
  await tick();
  assert.equal(h.processes.length, 1, 'a terminated pipe does not mean its native process exited');
  h.processes[0].emit('exit', 1); h.processes[0].emit('close');
  await tick();
  assert.equal(h.processes.length, 2);
  h.channels[0].reply({ id: 1, body: 'stale' });
  h.channels.at(-1).reply({ id: 1, body: 'current' });
  assert.equal(await replacement, 'current');
});

test('channel shutdown waits for the native close acknowledgement', async t => {
  const h = harness(t, { holdClose: true });
  const a = client(h.host);
  a.start(); await tick();
  let finished = false;
  const closing = a.shutdown().then(() => { finished = true; });
  await tick();
  assert.equal(h.channels[0].closed, true);
  assert.equal(finished, false, 'storage cannot be rebound before worker teardown');
  h.channels[0].acknowledgeClose();
  await closing;
  assert.equal(finished, true);
});

test('restart replaces the shared process and old channels can reopen', async t => {
  const h = harness(t, { request: (channel, request) => channel.reply({ id: request.id, body: request.body }) });
  const a = client(h.host);
  a.start(); assert.equal(await a.request('before'), 'before');
  await h.host.restart();
  assert.equal(a.isRunning(), false);
  a.start(); assert.equal(await a.request('after'), 'after');
  assert.equal(h.processes.length, 2);
  assert.deepEqual(h.processes[0].signals, ['SIGTERM']);
});

test('a full write queue cannot acknowledge a channel close', async t => {
  const h = harness(t);
  const a = client(h.host);
  a.start(); await tick();
  const write = h.host.process.write.bind(h.host.process);
  let blocked = true;
  h.host.process.write = parts => parts[0][1] === 3 && blocked
    ? Promise.reject(new Error('Native process write queue is full.')) : write(parts);
  let finished = false;
  const closing = a.shutdown().then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  assert.equal(h.channels[0].closed, false);
  blocked = false;
  await closing;
  assert.equal(h.channels[0].closed, true, 'close is retried after queued writes drain');
  assert.deepEqual(h.processes[0].signals, []);
});

test('timed-out shutdown keeps ownership and can finish after a late acknowledgement', async t => {
  const h = harness(t, { holdClose: true });
  const a = client(h.host);
  a.start(); await tick();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timedOut = assert.rejects(a.shutdown(), /shutdown timed out/);
  await tick();
  t.mock.timers.tick(10_000);
  await timedOut;
  h.channels[0].acknowledgeClose();
  await a.shutdown();
  assert.deepEqual(h.processes[0].signals, [], 'a slow service does not kill the other channels');
});
