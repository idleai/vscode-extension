'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, until } = require('./helpers/sharing.cjs');

test('native status stays stopped after a delayed command and resumes only retained approvals', async () => {
  const env = environment();
  try {
    const a = env.files.workspace('a'), b = env.files.workspace('b');
    const host = env.create(a), guest = env.create(b);
    const request = await guest.joinRequest();
    await host.stop();
    await assert.rejects(host.hostHistory(request, true), { code: 'cancelled' });
    assert.equal(host.status().enabled, false);
    const resumed = env.create(a);
    await assert.rejects(resumed.resume(), { code: 'invalid_request' });
    assert.equal(resumed.status().enabled, false);
  } finally { await env.stop(); }
});

test('the native status model reports ready only after authenticated inventory and content checks', async () => {
  const env = environment();
  try {
    const a = env.files.workspace('a'), b = env.files.workspace('b'); await a.start(); await a.edit('before', 'after');
    const host = env.create(a), guest = env.create(b);
    await guest.joinHistory(await host.hostHistory(await guest.joinRequest(), true), true);
    await until(() => guest.status().peers.some(peer => peer.state === 'Live'), 'native peer must finish reconciliation');
    const progress = guest.status().peers[0].progress;
    assert.equal(progress.accepted, true); assert.equal(progress.incoming.complete, true);
    assert.equal(progress.pending_records, 0); assert.equal(progress.pending_blobs, 0);
  } finally { await env.stop(); }
});
