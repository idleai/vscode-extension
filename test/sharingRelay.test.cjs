'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/sharingHost.cjs');

const marker = 'idle-relay-' + 'a'.repeat(24);
const keyFor = account => `idle.devTunnels.pending.${encodeURIComponent(account)}.${marker}`;

test('legacy ownership moves to the native journal only after durable import acknowledges it', async () => {
  const s = setup(({ f }) => {
    f.context.globalState.update(keyFor('account'), { owner: 'old', process: process.pid, leaseUntil: 0 });
  });
  try {
    await s.host.cleanup();
    assert.deepEqual(s.managers[0].importedMarkers, [marker]);
    assert.equal(s.f.context.globalState.get(keyFor('account')), undefined);
  } finally { await s.host.shutdown(); }
});

test('failed native import preserves the old cleanup record for another attempt', async () => {
  const s = setup(({ f }) => {
    f.context.globalState.update(keyFor('account'), { owner: 'old', process: process.pid, leaseUntil: 0 });
  }, manager => { manager.importCleanup = async () => { throw new Error('fixture private storage unavailable'); }; });
  try {
    await assert.rejects(s.host.cleanup());
    assert.ok(s.f.context.globalState.get(keyFor('account')));
    s.managers[0].importCleanup = async markers => s.managers[0].importedMarkers.push(...markers);
    await s.host.cleanup();
    assert.deepEqual(s.managers[0].importedMarkers, [marker]);
    assert.equal(s.f.context.globalState.get(keyFor('account')), undefined);
  } finally { await s.host.shutdown(); }
});

test('cleanup never imports markers active in another window or recorded for another account', async () => {
  const s = setup(({ f }) => {
    f.context.globalState.update(keyFor('account'), { owner: 'another-window', process: process.pid, leaseUntil: Date.now() + 90_000 });
    f.context.globalState.update(keyFor('other'), { owner: 'old', process: process.pid, leaseUntil: 0 });
  });
  try {
    await s.host.cleanup();
    assert.deepEqual(s.managers[0].importedMarkers, []);
    assert.ok(s.f.context.globalState.get(keyFor('account')));
    assert.ok(s.f.context.globalState.get(keyFor('other')));
  } finally { await s.host.shutdown(); }
});
