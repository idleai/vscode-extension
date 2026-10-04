'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { environment, until, diffs, decode, encode, crash } = require('./helpers/sharing.cjs');
const live = manager => manager.status().peers.filter(peer => peer.state === 'Live').length;

function saved(local) { return JSON.parse(fs.readFileSync(path.join(local.root, '.sharing/state/saved-sharing.json'), 'utf8')); }
const sees = async (local, text) => (await diffs(local)).some(row => row.after === text);

test('native restart retains the exact device, space, consent cutoff and approved devices', async () => {
  const env = environment();
  try {
    const a = env.files.workspace('a'), b = env.files.workspace('b'); await a.start();
    const host = env.create(a), guest = env.create(b);
    const first = decode(await host.hostHistory(await guest.joinRequest(), false));
    const ledger = fs.readFileSync(path.join(a.chain, 'multiplayer/scope.json'));
    const identity = await host.joinRequest();
    await host.suspend();
    const restored = env.create(a); await restored.resume();
    assert.equal(await restored.joinRequest(), identity);
    assert.equal(restored.status().space, first.space);
    assert.deepEqual(fs.readFileSync(path.join(a.chain, 'multiplayer/scope.json')), ledger);
    assert.equal((await restored.devices()).length, 1);
    await restored.suspend();
    const moved = { ...a, chain: path.join(env.files.directory, 'moved-chain') };
    fs.renameSync(a.chain, moved.chain);
    const resumed = env.create(moved); await resumed.resume();
    assert.equal(resumed.status().space, first.space);
    assert.deepEqual(fs.readFileSync(path.join(moved.chain, 'multiplayer/scope.json')), ledger);
  } finally { await env.stop(); }
});

test('a lost native process can resume and repair offline edits; revocation survives the next restart', { timeout: 45_000 }, async () => {
  const env = environment();
  try {
    const a = env.files.workspace('a'), b = env.files.workspace('b'); await a.start(); await b.start();
    const host = env.create(a), guest = env.create(b);
    const invitation = await host.hostHistory(await guest.joinRequest(), true); await guest.joinHistory(invitation, true);
    await until(() => live(guest) === 1, 'initial connection');
    await crash(host);
    await a.edit('offline before\n', 'offline repaired\n');
    await host.resume();
    await until(async () => live(guest) === 1 && await sees(b, 'offline repaired\n'), 'native reconnection must repair history');
    await guest.revoke(decode(invitation).host.fingerprint); await guest.suspend();
    const restarted = env.create(b); await restarted.resume();
    assert.deepEqual(await restarted.devices(), []);
    assert.deepEqual(restarted.status().peers, []);
  } finally { await env.stop(); }
});

test('native migration rejects conflicting spaces and keeps a lost acknowledgement from undoing Stop', async () => {
  const env = environment();
  try {
    const a = env.files.workspace('a'), b = env.files.workspace('b');
    const host = env.create(a), guest = env.create(b);
    await guest.joinHistory(await host.hostHistory(await guest.joinRequest(), false), true);
    const copy = saved(b);
    await guest.suspend();
    fs.rmSync(path.join(b.root, '.sharing'), { recursive: true });
    const migrated = env.create(b);
    await assert.rejects(migrated.importSaved({ ...copy, space: 'another-space' }));
    await migrated.importSaved(copy);
    assert.equal(migrated.status().enabled, false, 'import itself cannot enable sharing');
    await migrated.importSaved(copy); await migrated.resume();
    await migrated.stop();
    const retry = env.create(b); await retry.importSaved(copy);
    await assert.rejects(retry.resume(), { code: 'invalid_request' });
    assert.equal(fs.existsSync(path.join(b.root, '.sharing/state/saved-sharing.json')), false);
  } finally { await env.stop(); }
});

test('opposite invitations converge to one authenticated native edge at both ends', { timeout: 30_000 }, async () => {
  const env = environment();
  try {
    const a = env.files.workspace('a'), b = env.files.workspace('b'); await a.start(); await b.start();
    const left = env.create(a), right = env.create(b);
    await right.joinHistory(await left.hostHistory(await right.joinRequest(), true), true);
    await left.joinHistory(await right.hostHistory(await left.joinRequest(), 'keep'), 'keep');
    await until(() => live(left) === 1 && live(right) === 1 && left.status().peers.length === 1 && right.status().peers.length === 1, 'duplicate edges must settle');
    await a.edit('mesh before\n', 'mesh after\n');
    await until(() => sees(b, 'mesh after\n'), 'the retained edge must keep transferring');
  } finally { await env.stop(); }
});

test('scope changes preserve previously received copies and the exact replacement cutoff across restart', { timeout: 45_000 }, async () => {
  const env = environment();
  try {
    const a = env.files.workspace('a'), b = env.files.workspace('b'); await a.start(); await b.start();
    await a.edit('old before\n', 'old private result\n');
    const host = env.create(a), guest = env.create(b), request = await guest.joinRequest();
    await host.hostHistory(request, true);
    const invitation = await host.hostHistory(request, false), first = host.status().scope;
    await guest.joinHistory(invitation, false);
    await until(() => live(host) === 1 && live(guest) === 1, 'new cutoff connects');
    assert.equal(host.status().peers[0].progress.outgoing.total_records, 0);
    assert.deepEqual(await diffs(b), []);
    await a.edit('new before\n', 'new shared result\n');
    await until(() => sees(b, 'new shared result\n'), 'post-cutoff edit arrives');
    await host.changeScope(true);
    await until(() => sees(b, 'old private result\n'), 'all-history backfill arrives');
    await host.changeScope(false);
    const second = host.status().scope;
    assert.ok(second.revision > first.revision);
    await until(() => host.status().peers.some(peer => peer.progress?.accepted && peer.progress.outgoing.complete && peer.progress.outgoing.total_records === 0), 'old receipts cannot widen the new boundary');
    assert.ok(await sees(b, 'old private result\n'));
    await guest.changeScope(false);
    await host.suspend(); await a.edit('offline before\n', 'offline after cutoff\n');
    const restored = env.create(a); await restored.resume();
    assert.deepEqual(restored.status().scope, second);
    await until(() => sees(b, 'offline after cutoff\n'), 'offline work inside the retained scope arrives');
  } finally { await env.stop(); }
});
