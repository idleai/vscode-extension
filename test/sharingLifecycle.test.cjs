'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { environment, decode, crash } = require('./helpers/sharing.cjs');
const savedPath = local => path.join(local.root, '.sharing/state/saved-sharing.json');

async function connected() {
  const env = environment(), a = env.files.workspace('a'), b = env.files.workspace('b');
  const host = env.create(a), guest = env.create(b);
  const invitation = await host.hostHistory(await guest.joinRequest(), true);
  await guest.joinHistory(invitation, true);
  return { env, a, b, host, guest, invitation: decode(invitation) };
}

test('Stop cancels a pending removal and leaves no native session to resume', async () => {
  const s = await connected();
  try {
    const removing = s.guest.revoke(s.invitation.host.fingerprint);
    const settled = removing.catch(error => { assert.equal(error.code, 'cancelled'); });
    await s.guest.stop(); await settled;
    assert.equal(fs.existsSync(savedPath(s.b)), false);
    assert.equal(s.guest.status().enabled, false);
    const reopened = s.env.create(s.b);
    await assert.rejects(reopened.resume(), { code: 'invalid_request' });
  } finally { await s.env.stop(); }
});

test('retired host calls cannot rewrite a newly approved native session', async () => {
  const s = await connected();
  try {
    await s.guest.stop();
    const replacement = s.env.create(s.b);
    await replacement.joinHistory(await s.host.hostHistory(await replacement.joinRequest(), 'keep'), 'keep');
    const saved = fs.readFileSync(savedPath(s.b));
    await assert.rejects(s.guest.revoke(s.invitation.host.fingerprint), { code: 'cancelled' });
    assert.deepEqual(fs.readFileSync(savedPath(s.b)), saved);
    assert.equal(replacement.status().enabled, true);
  } finally { await s.env.stop(); }
});

test('a committed removal persists across suspension and restart without reenrollment', async () => {
  const s = await connected();
  try {
    await s.guest.revoke(s.invitation.host.fingerprint);
    assert.deepEqual(JSON.parse(fs.readFileSync(savedPath(s.b))).peers, []);
    await s.guest.suspend();
    const replacement = s.env.create(s.b); await replacement.resume();
    assert.deepEqual(await replacement.devices(), []);
    assert.deepEqual(replacement.status().peers, []);
  } finally { await s.env.stop(); }
});

test('suspension during a pending operation retains private resumption and consent', async () => {
  const s = await connected();
  try {
    const before = fs.readFileSync(path.join(s.b.chain, 'multiplayer/scope.json'));
    const removing = s.guest.revoke(s.invitation.host.fingerprint);
    const settled = removing.catch(error => { assert.equal(error.code, 'cancelled'); });
    await s.guest.suspend(); await settled;
    assert.equal(fs.existsSync(savedPath(s.b)), true);
    assert.deepEqual(fs.readFileSync(path.join(s.b.chain, 'multiplayer/scope.json')), before);
    const replacement = s.env.create(s.b); await replacement.resume();
    assert.equal(replacement.status().enabled, true);
  } finally { await s.env.stop(); }
});

test('explicit Stop after simultaneous suspension still clears the durable native session', async () => {
  const s = await connected();
  try {
    await Promise.all([s.guest.suspend(), s.guest.stop()]);
    assert.equal(fs.existsSync(savedPath(s.b)), false);
    const replacement = s.env.create(s.b);
    await assert.rejects(replacement.resume(), { code: 'invalid_request' });
  } finally { await s.env.stop(); }
});


test('Stop after an unexpected native exit clears retained state before reporting success', async () => {
  const s = await connected();
  try {
    await crash(s.guest);
    assert.equal(fs.existsSync(savedPath(s.b)), true);
    await s.guest.stop();
    assert.equal(fs.existsSync(savedPath(s.b)), false);
    const replacement = s.env.create(s.b);
    await assert.rejects(replacement.resume(), { code: 'invalid_request' });
  } finally { await s.env.stop(); }
});
