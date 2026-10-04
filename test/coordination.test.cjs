const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { CoordinationClient } = require('../out/host/coordinationClient');
const { FrameDecoder, encodeFrame } = require('../out/host/frameDecoder');
const { fakeChild } = require('./fixtures/process-fake.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function messages(child) {
  const decoder = new FrameDecoder(16 * 1024 * 1024, 'big');
  return child.writes.flatMap(chunk => [...decoder.push(chunk)].map(frame => JSON.parse(frame)));
}
function reply(child, response) {
  child.stdout.emit('data', encodeFrame([JSON.stringify(response)], 16 * 1024 * 1024, 'big'));
}

test('coordinator frames preserve exact responses and serialize concurrent view reads', async t => {
  const child = fakeChild();
  const client = new CoordinationClient({ spawn: () => child });
  t.after(() => client.shutdown());
  client.start('/coordinator', { args: ['--config', '/private/host.json'], cwd: '/workspace' });
  const first = client.request('{"kind":"snapshot"}');
  const second = client.request('{"kind":"presence"}');
  await tick();
  assert.equal(messages(child).length, 1);
  const request = messages(child)[0];
  assert.deepEqual(request.data.command, { kind: 'snapshot' });
  assert.equal(request.data.version, 1);
  const raw = '{"version":1,"id":"' + request.data.id + '","result":{"Ok":{"position":"18446744073709551615"}}}';
  const frame = encodeFrame([raw], 16 * 1024 * 1024, 'big');
  for (const byte of frame) child.stdout.emit('data', Buffer.from([byte]));
  assert.equal(await first, raw);
  await tick();
  const next = messages(child)[1];
  assert.notEqual(next.data.id, request.data.id);
  reply(child, { version: 1, id: next.data.id, result: { Ok: [] } });
  assert.deepEqual(JSON.parse(await second).result.Ok, []);
});

test('cancelled reads release listeners and ignore late responses', async t => {
  const child = fakeChild();
  const client = new CoordinationClient({ spawn: () => child });
  t.after(() => client.shutdown());
  client.start('/coordinator', {});
  const abort = new AbortController();
  const pending = client.request('{"kind":"snapshot"}', abort.signal);
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await tick();
  const id = messages(child)[0].data.id;
  abort.abort();
  await rejected;
  await tick();
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.deepEqual(messages(child)[1], { kind: 'cancel', data: id });
  reply(child, { version: 1, id, result: { Ok: { stale: true } } });
  const next = client.request('{"kind":"presence"}');
  await tick();
  const current = messages(child).at(-1).data.id;
  reply(child, { version: 1, id: current, result: { Ok: [] } });
  assert.deepEqual(JSON.parse(await next).result.Ok, []);
});

test('malformed frames fail pending reads without exposing native output', async t => {
  const child = fakeChild();
  const client = new CoordinationClient({ spawn: () => child });
  t.after(() => client.shutdown());
  client.start('/coordinator', {});
  const pending = client.request('{"kind":"snapshot"}');
  const rejected = assert.rejects(pending, error => error.code === 'unavailable' && !error.message.includes('private'));
  await tick();
  reply(child, { private: 'unexpected diagnostics' });
  await rejected;
  assert.equal(client.isRunning(), false);
});

test('coordinator timeouts remain retryable and permission failures stop retries', async t => {
  const child = fakeChild();
  const client = new CoordinationClient({ spawn: () => child });
  t.after(() => client.shutdown());
  client.start('/coordinator', {});
  for (const [native, code] of [['timeout', 'host_timeout'], ['cancelled', 'host_timeout'], ['busy', 'busy'], ['forbidden', 'denied'], ['expired', 'denied'], ['invalid', 'invalid_request']]) {
    const pending = client.request('{"kind":"snapshot"}');
    const rejected = assert.rejects(pending, { code });
    await tick();
    reply(child, { version: 1, id: messages(child).at(-1).data.id, result: { Err: native } });
    await rejected;
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = client.request('{"kind":"snapshot"}');
  const rejected = assert.rejects(pending, { code: 'host_timeout' });
  await tick();
  const id = messages(child).at(-1).data.id;
  t.mock.timers.tick(16_000);
  await rejected;
  assert.deepEqual(messages(child).at(-1), { kind: 'cancel', data: id });
  t.mock.timers.reset();
});

test('private credential callbacks remain usable while a service request is waiting', async t => {
  const child = fakeChild(), requested = [];
  const client = new CoordinationClient({ spawn: () => child }, async purpose => {
    requested.push(purpose); return 'private-' + requested.length;
  });
  t.after(() => client.shutdown());
  client.start('/coordinator', {});
  const call = client.request('{"kind":"cleanup"}');
  await tick();
  const id = messages(child)[0].data.id;
  for (const [index, purpose] of ['management', 'management', 'discovery'].entries()) {
    reply(child, { kind: 'credential', data: { id: 'credential-' + index, purpose } });
    await tick();
    assert.deepEqual(messages(child).at(-1), { kind: 'credential', data: { id: 'credential-' + index, token: 'private-' + (index + 1) } });
  }
  reply(child, { version: 1, id, result: { Ok: null } });
  assert.equal(JSON.parse(await call).result.Ok, null);
  assert.deepEqual(requested, ['management', 'management', 'discovery'], 'each callback requests current host authorization');
});

test('credential denial and late provider results never disclose exception text or retired tokens', async t => {
  const child = fakeChild(); let release;
  let reject = true;
  const client = new CoordinationClient({ spawn: () => child }, () => {
    if (reject) throw new Error('private provider diagnostic');
    return new Promise(resolve => { release = resolve; });
  });
  t.after(() => client.shutdown());
  client.start('/coordinator', {});
  reply(child, { kind: 'credential', data: { id: 'denied', purpose: 'management' } });
  await tick();
  assert.deepEqual(messages(child), [{ kind: 'credential', data: { id: 'denied', token: null } }]);
  reject = false;
  reply(child, { kind: 'credential', data: { id: 'retired', purpose: 'management' } });
  await tick();
  await client.shutdown();
  release('stale private token'); await tick();
  assert.equal(messages(child).length, 1, 'closed native owners cannot receive late credentials');
  assert.ok(!JSON.stringify(messages(child)).includes('private'));
});

test('unknown credential purposes and oversized callback queues close the private connection', async t => {
  for (const value of [{ id: 'bad', purpose: 'untrusted' }, { id: '', purpose: 'management' }]) {
    const child = fakeChild();
    let credentials = 0;
    const client = new CoordinationClient({ spawn: () => child }, async () => { credentials++; return 'private'; });
    client.start('/coordinator', {});
    reply(child, { kind: 'credential', data: value }); await tick();
    assert.equal(client.isRunning(), false); assert.equal(credentials, 0);
    await client.shutdown();
  }
  const child = fakeChild(), waiting = [];
  const client = new CoordinationClient({ spawn: () => child }, () => new Promise(resolve => waiting.push(resolve)));
  t.after(() => client.shutdown());
  client.start('/coordinator', {});
  for (let index = 0; index < 9; index++) reply(child, { kind: 'credential', data: { id: String(index), purpose: 'management' } });
  assert.equal(client.isRunning(), false);
  assert.equal(waiting.length, 8);
  waiting.forEach(resolve => resolve('retired')); await tick();
  assert.deepEqual(messages(child), []);
});
