'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once, getEventListeners } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const { StdioClient } = require('../out/host/processes');
const { NativeWorker } = require('../out/host/nativeWorker');
const { frame, fakeChild } = require('./fixtures/process-fake.cjs');

const fixture = path.join(__dirname, 'fixtures', 'process-child.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native launch forwards the selected host cwd/args and does not launch twice', t => {
  const calls = [];
  const client = new StdioClient({ spawn: (...args) => { calls.push(args); return fakeChild(); } });
  t.after(() => client.dispose());
  client.start('/native', { args: ['--stdio'], cwd: '/selected-host/repo' });
  client.ensureStarted('/ignored');
  assert.deepEqual(calls, [['/native', ['--stdio'], {
    cwd: '/selected-host/repo', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  }]]);
});

test('real history process preserves durable UTF-8 and runs in the supplied directory', { timeout: 5000 }, async t => {
  const client = new StdioClient();
  t.after(() => client.dispose());
  client.start(process.execPath, { args: [fixture, 'echo'], cwd: os.tmpdir() });
  const body = { before: '😀 é\n\\"\u0001'.repeat(1000), after: 'human 🦀 edit' };
  const bytes = Buffer.from(JSON.stringify(body));
  bytes.toString = () => { throw new Error('serialized content must not be decoded'); };
  const [first, second] = await Promise.all([
    client.requestJson([Buffer.from('{"nested":'), bytes, Buffer.from('}')]),
    client.request({ ping: true }),
  ]);
  assert.deepEqual(first, { echo: { nested: body }, cwd: os.tmpdir() });
  assert.deepEqual(second.echo, { ping: true });
});

test('late old-generation frames, errors and write callbacks cannot affect a replacement', async t => {
  const old = fakeChild({ writesComplete: false, ignoresTerm: true });
  const fresh = fakeChild();
  const children = [old, fresh];
  const client = new StdioClient({ spawn: () => children.shift(), terminationGraceMs: 20 });
  t.after(() => client.dispose());
  client.start('/native');
  const stale = client.request({ stale: true });
  const rejected = assert.rejects(stale, /stopped/);
  old.stdout.emit('data', frame({ id: 1, body: 'stale' }).subarray(0, 7));
  client.stop();
  client.start('/native');
  const pending = client.request({ fresh: true });
  old.reply({ id: 1, body: 'stale' });
  old.stdin.emit('error', new Error('private old diagnostic'));
  old.callbacks[0](new Error('private old callback'));
  old.emit('exit', 3);
  fresh.reply({ id: 1, body: { fresh: true } });
  assert.deepEqual(await pending, { fresh: true });
  await rejected;
  assert.equal(client.isRunning(), true);
});

test('SIGTERM-ignoring real children remain owned across restart and receive SIGKILL', { timeout: 5000 }, async t => {
  const children = [];
  const client = new StdioClient({
    terminationGraceMs: 30,
    spawn: (...args) => { const child = spawn(...args); children.push(child); return child; },
  });
  t.after(() => { client.dispose(); for (const child of children) child.kill('SIGKILL'); });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  client.setMessageHandler(message => { if (message.ready) ready(); });
  client.start(process.execPath, { args: [fixture, 'stubborn'], cwd: os.tmpdir() });
  await started;
  const exited = once(children[0], 'exit');
  client.stop();
  client.start(process.execPath, { args: [fixture, 'echo'], cwd: os.tmpdir() });
  assert.deepEqual((await client.request({ replacement: true })).echo, { replacement: true });
  assert.equal((await exited)[1], 'SIGKILL');
  assert.equal(client.isRunning(), true);
});

test('shutdown waits for a real SIGTERM-ignoring child to exit after escalation', { timeout: 5000 }, async t => {
  let child;
  const client = new StdioClient({
    terminationGraceMs: 30,
    spawn: (...args) => { child = spawn(...args); return child; },
  });
  t.after(() => { client.dispose(); child?.kill('SIGKILL'); });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  client.setMessageHandler(message => { if (message.ready) ready(); });
  client.start(process.execPath, { args: [fixture, 'stubborn'], cwd: os.tmpdir() });
  await started;
  await client.shutdown();
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(client.isRunning(), false);
  await client.shutdown();
  assert.throws(() => client.start('/native'), /disposed/);
});

test('a shutdown timeout retains ownership and continues kill attempts until the OS reports exit', { timeout: 5000 }, async t => {
  const child = fakeChild();
  child.kill = signal => { child.signals.push(signal); return false; };
  const client = new StdioClient({ spawn: () => child, terminationGraceMs: 1, shutdownTimeoutMs: 20 });
  t.after(() => { child.emit('exit', null); client.dispose(); });
  client.start('/native');
  await assert.rejects(client.shutdown(), error => error.message === 'Native process shutdown timed out.');
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL', 'SIGKILL']);
  child.emit('exit', null);
  await client.shutdown();
});

test('malformed framing, unknown JSON values and invalid envelopes fail closed with safe errors', async t => {
  const large = Buffer.alloc(4); large.writeUInt32LE(129);
  const cases = [large, frame(Buffer.alloc(0)), frame(Buffer.from('secret-token malformed')),
    frame(null), frame([]), frame('text'), frame(42), frame({ id: '1', body: true }),
    frame({ id: 1 }), frame(Buffer.from([0x22, 0xff, 0x22]))];
  for (const bytes of cases) {
    const child = fakeChild();
    const client = new StdioClient({ spawn: () => child, maxFrameBytes: 128 });
    t.after(() => client.dispose());
    client.start('/native');
    const pending = client.request({ query: true });
    child.stdout.emit('data', bytes);
    await assert.rejects(pending, error => error.message === 'Invalid native process framing or response.');
    assert.equal(client.isRunning(), false);
    assert.deepEqual(child.signals, ['SIGTERM']);
  }
});

test('unsolicited messages are distinct from unmatched response IDs', async t => {
  const child = fakeChild();
  const client = new StdioClient({ spawn: () => child });
  t.after(() => client.dispose());
  const updates = [];
  client.setMessageHandler(message => updates.push(message));
  client.start('/native');
  const pending = client.request({ ping: true });
  child.reply({ id: 1000, body: { stale: true } });
  child.reply({ body: { update: true } });
  child.reply({ id: 1, body: null });
  assert.equal(await pending, null);
  assert.deepEqual(updates, [{ body: { update: true } }]);
});

test('host callback failures do not alter the native process lifetime', async t => {
  const child = fakeChild();
  const client = new StdioClient({ spawn: () => child });
  t.after(() => client.dispose());
  client.setMessageHandler(() => { throw new Error('view closed'); });
  client.setLog(() => { throw new Error('output closed'); });
  client.start('/native');
  const pending = client.request('hello');
  child.reply({ update: true });
  child.stderr.emit('data', Buffer.from('private native diagnostic'));
  child.reply({ id: 1, body: 'valid' });
  assert.equal(await pending, 'valid');
  assert.equal(client.isRunning(), true);
});

test('synchronous writes and asynchronous stream errors reject all requests safely', async t => {
  for (const failure of ['sync', 'stdin', 'stdout', 'exit']) {
    const child = fakeChild({ writeError: failure === 'sync' ? new Error('private payload') : undefined });
    const client = new StdioClient({ spawn: () => child });
    t.after(() => client.dispose());
    client.start('/native');
    const pending = client.request({ ping: true });
    if (failure === 'exit') child.emit('exit', 3);
    else if (failure !== 'sync') child[failure].emit('error', new Error('private payload'));
    await assert.rejects(pending, error => /Native process/.test(error.message) && !error.message.includes('private'));
    assert.equal(client.isRunning(), false);
  }
});

test('writes remain bounded while a child applies backpressure', async t => {
  const child = fakeChild({ writesComplete: false });
  const client = new StdioClient({ spawn: () => child, maxFrameBytes: 100, maxQueuedBytes: 100 });
  t.after(() => client.dispose());
  client.start('/native');
  const first = client.request('x'.repeat(20));
  const second = client.request('y'.repeat(20));
  await assert.rejects(client.request('z'.repeat(20)), /queue is full/);
  assert.equal(child.writes.length, 1);
  child.callbacks[0]();
  await tick();
  assert.equal(child.writes.length, 2);
  child.reply({ id: 1, body: true });
  child.reply({ id: 2, body: true });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('deadlines and aborts settle only their request and unregister listeners', async t => {
  const child = fakeChild();
  const client = new StdioClient({ spawn: () => child });
  t.after(() => client.dispose());
  client.start('/native');
  const abort = new AbortController();
  const cancelled = client.request('cancel', { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, /aborted/);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  await assert.rejects(client.request('timeout', { timeoutMs: 5 }), /timed out/);
  const successful = client.request('next');
  child.reply({ id: 1, body: 'late cancelled response' });
  child.reply({ id: 2, body: 'late timed out response' });
  child.reply({ id: 3, body: 'fresh' });
  assert.equal(await successful, 'fresh');
  assert.equal(client.isRunning(), true);
});

test('invalid requests are rejected without corrupting the process and disposal is final', async t => {
  const child = fakeChild();
  const client = new StdioClient({ spawn: () => child, maxFrameBytes: 64 });
  t.after(() => client.dispose());
  await assert.rejects(client.request(true), /not running/);
  client.start('/native');
  const circular = {}; circular.self = circular;
  await assert.rejects(client.request(circular), /not JSON serializable/);
  await assert.rejects(client.request(undefined), /not JSON serializable/);
  await assert.rejects(client.request('x'.repeat(64)), /configured limit/);
  await assert.rejects(client.request(true, { timeoutMs: Number.NaN }), /timeout/);
  assert.equal(child.writes.length, 0);
  client.dispose();
  assert.throws(() => client.start('/native'), /disposed/);
});

test('peer worker uses its own serialized control envelopes and preserves unknown results', { timeout: 5000 }, async t => {
  const worker = new NativeWorker(process.execPath, { args: [fixture, 'worker'], cwd: os.tmpdir() });
  t.after(() => worker.dispose());
  const pending = worker.request({ type: 'open', space: 'test' });
  await assert.rejects(worker.request({ type: 'turn' }), /serialized/);
  assert.deepEqual(await pending, { echo: { type: 'open', space: 'test' }, cwd: os.tmpdir() });
  assert.deepEqual((await worker.request(null)).echo, null);
});

test('peer worker suppresses arbitrary error text and closes after a response deadline', async t => {
  const child = fakeChild();
  const worker = new NativeWorker('/native', { spawn: () => child, timeoutMs: 5 });
  t.after(() => worker.dispose());
  const failed = worker.request({ type: 'open' });
  child.reply({ ok: false, error: 'secret-provider-token' });
  await assert.rejects(failed, error => error.message === 'Native multiplayer: invalid_native_response');
  await assert.rejects(worker.request({ type: 'turn' }), /timed out/);
  await assert.rejects(worker.request({ type: 'turn' }), /closed/);
  assert.deepEqual(child.signals, ['SIGTERM']);
});
