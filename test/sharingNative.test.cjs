'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { environment, until, blobs, diffs, rows, decode, encode } = require('./helpers/sharing.cjs');

const live = manager => manager.status().peers.filter(peer => peer.state === 'Live').length;

test('native coordinator processes deliver captured history and content while working trees stay local', { timeout: 45_000 }, async () => {
  const env = environment();
  try {
    const a = env.files.workspace('a', 'Recorder A'), b = env.files.workspace('b', 'Recorder B');
    await a.start(); await b.start();
    await a.edit('before A\n', 'after A\n'); await b.edit('before B\n', 'after B\n');
    const host = env.create(a), guest = env.create(b);
    const invitation = await host.hostHistory(await guest.joinRequest(), true);
    await guest.joinHistory(invitation, true);
    await until(async () => live(host) === 1 && live(guest) === 1
      && (await diffs(a)).length >= 2 && (await diffs(b)).length >= 2, 'both native engines must reconcile captured history')
      .catch(error => {
        throw new Error(`${error.message}; host=${JSON.stringify(host.status())}; guest=${JSON.stringify(guest.status())}`, { cause: error });
      });
    assert.ok((await diffs(b)).some(row => row.after === 'after A\n'));
    assert.ok((await diffs(a)).some(row => row.after === 'after B\n'));
    assert.deepEqual(blobs(a.chain), blobs(b.chain));
    assert.equal(fs.readFileSync(path.join(b.root, 'shared.ts'), 'utf8'), 'Working tree stays local.\n');
    const device = decode(await guest.joinRequest()).device;
    assert.ok((await host.devices()).some(value => value.fingerprint === device.fingerprint));
    assert.ok(host.status().peers[0].progress.accepted);
    assert.ok(host.status().peers[0].connection, 'Rust supplies connection identities for status observations');
    const before = (await rows(b)).length;
    await a.edit('live before\n', 'live native transfer\n');
    await until(async () => (await rows(b)).length > before && (await diffs(b)).some(row => row.after === 'live native transfer\n'), 'live updates must arrive');
    assert.ok(host.status().durable_changes > 0 || guest.status().durable_changes > 0);
    assert.ok(!JSON.stringify(host.status()).includes(decode(invitation).connectToken));
  } finally { await env.stop(); }
});

test('Rust preview rejects wrong devices, altered certificates, expired grants and unsafe relay addresses', async () => {
  const env = environment();
  try {
    const host = env.create(env.files.workspace('host')), guest = env.create(env.files.workspace('guest'));
    const request = decode(await guest.joinRequest());
    await assert.rejects(host.inspectRequest(encode({ ...request, device: { ...request.device, fingerprint: 'f'.repeat(64) } })));
    const encoded = await host.hostHistory(encode(request), false);
    const invitation = decode(encoded);
    assert.equal((await guest.inspectInvitation(encoded)).guest, request.device.fingerprint);
    for (const replacement of [
      { ...invitation, guest: 'another-device' }, { ...invitation, expiresAt: 1 },
      { ...invitation, endpoint: { ...invitation.endpoint, hostPublicKeys: [] } },
      ...['ws://fixture.rel.tunnels.api.visualstudio.com/x', 'wss://localhost/x', 'wss://github.com/x',
        'wss://owner@fixture.rel.tunnels.api.visualstudio.com/x'].map(clientRelayUri =>
        ({ ...invitation, endpoint: { ...invitation.endpoint, clientRelayUri } })),
    ]) await assert.rejects(guest.inspectInvitation(encode(replacement)));
    assert.equal(guest.status().enabled, false, 'validation cannot approve a device or create consent');
  } finally { await env.stop(); }
});
