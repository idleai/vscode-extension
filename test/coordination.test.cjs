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
