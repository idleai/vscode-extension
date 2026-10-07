const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getEventListeners } = require('node:events');
const { setImmediate: turn } = require('node:timers/promises');
const { fixture, loadWithVSCode, uri } = require('./helpers/vscode.cjs');

const f = fixture();
const { NativeHistoryProvider } = loadWithVSCode('../../out/history/native', f.api);
const binding = { root: uri('file:///one'), chainDirectory: '/one/chain',
  repository: { workspace_id: 'workspace', repository_id: 'repository', chain: 'chain' } };
const request = { binding: binding.repository, source: 'current', target: 'File',
  record: { operation: '1'.repeat(64), hash: '2'.repeat(64) } };
const storage = { Err: { code: 'storage', message: 'Unable to read the bound history source.', candidates: [] } };
const preview = selected => ({ Ok: { request: selected, documents: [{ name: 'recorded.txt',
  record: selected.record, field: 'FileAfter', reference: null, bytes: 'exact recorded bytes' }] } });

function setup(t, respond) {
  const requests = [];
  let events;
  let running = false;
  const stop = () => { running = false; events.closed(new Error('Native channel closed.')); };
  const native = { connection: () => callbacks => {
    events = callbacks;
    return {
      isRunning: () => running,
      start: () => { running = true; },
      async write(parts) {
        const envelope = JSON.parse(parts.join(''));
        requests.push(envelope.body);
        const body = respond(envelope.body, requests.length);
        if (body !== undefined) events.frame(Buffer.from(JSON.stringify({ id: envelope.id, body })));
      },
      stop, dispose: stop, async shutdown() { stop(); },
    };
  } };
  const provider = new NativeHistoryProvider(native, binding);
  t.after(() => { f.api.workspace.isTrusted = true; return provider.shutdown(); });
  return { provider, requests };
}

test('a native preview survives brief storage contention and preserves its exact request and bytes', async t => {
  const h = setup(t, (selected, count) => count < 3 ? storage : preview(selected));
  const result = await h.provider.resolve(request, new AbortController().signal);
  assert.deepEqual(result, preview(request).Ok);
  assert.equal(h.requests.length, 3);
  assert(h.requests.every(selected => JSON.stringify(selected) === JSON.stringify(request)));
});

test('persistent storage failures remain visible after bounded retries', async t => {
  const h = setup(t, () => storage);
  await assert.rejects(h.provider.resolve(request, new AbortController().signal), { code: 'storage', message: storage.Err.message });
  assert.equal(h.requests.length, 4);
});

for (const method of ['query', 'projection']) test(`${method} reads recover the storage error format used by released hosts`, async t => {
  const result = { Ok: { records: [request.record], bytes: 'exact query result' } };
  const h = setup(t, (_selected, count) => count === 1 ? { Err: { message: storage.Err.message } } : result);
  const params = { chain: binding.repository.chain, action: 'read' };
  assert.deepEqual(await h.provider[method](params, new AbortController().signal), result);
  assert.equal(h.requests.length, 2);
  for (const selected of h.requests) {
    assert.deepEqual(selected.binding, binding.repository);
    assert.deepEqual(selected[method], params);
  }
});

test('persistent query storage failures retain their original reply after bounded retries', async t => {
  const failure = { Err: { message: storage.Err.message } };
  const h = setup(t, () => failure);
  assert.deepEqual(await h.provider.query({}, new AbortController().signal), failure);
  assert.equal(h.requests.length, 4);
});

test('missing content, invalid queries and transport failures are returned without retrying', async t => {
  const missing = setup(t, () => ({ Err: { code: 'missing_content', message: 'Content is unavailable.', candidates: [] } }));
  await assert.rejects(missing.provider.resolve(request, new AbortController().signal), { code: 'missing_content' });
  assert.equal(missing.requests.length, 1);
  const broken = setup(t, () => { throw new Error('Native transport failed.'); });
  await assert.rejects(broken.provider.resolve(request, new AbortController().signal), /Native transport failed/);
  assert.equal(broken.requests.length, 1);
  const failure = { Err: { message: 'The query belongs to a different repository or chain.' } };
  const invalid = setup(t, () => failure);
  assert.deepEqual(await invalid.provider.query({}, new AbortController().signal), failure);
  assert.equal(invalid.requests.length, 1);
});

test('an aborted native history query reports cancellation and releases its listener', async t => {
  const h = setup(t, () => undefined);
  const abort = new AbortController();
  const rejected = assert.rejects(h.provider.query({ action: 'pending' }, abort.signal), { code: 'cancelled' });
  abort.abort();
  await rejected;
  assert.equal(h.requests.length, 1);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

for (const reason of ['abort', 'shutdown', 'trust']) test(`storage retries stop after ${reason}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t, () => storage);
  const abort = new AbortController();
  const rejected = assert.rejects(h.provider.resolve(request, abort.signal),
    { code: reason === 'trust' ? 'workspace_untrusted' : 'cancelled' });
  await turn();
  assert.equal(h.requests.length, 1);
  if (reason === 'abort') abort.abort();
  else if (reason === 'shutdown') await h.provider.shutdown();
  else f.api.workspace.isTrusted = false;
  t.mock.timers.tick(25);
  await rejected;
  assert.equal(h.requests.length, 1, 'retired requests never read again');
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});
