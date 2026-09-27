const assert = require('node:assert/strict');
const test = require('node:test');
const { TunnelJournal } = require('../out/host/tunnelJournal');
const marker = 'idle-relay-' + 'a'.repeat(24);

test('active tunnel leases exclude cleanup and other windows; released leases remain account-scoped', async () => {
  const records = new Map();
  const state = { keys: () => [...records.keys()], get: key => records.get(key), update: async (key, value) => { if (value === undefined) records.delete(key); else records.set(key, value); } };
  const first = new TunnelJournal(state, 'account', () => 1000, () => true);
  const second = new TunnelJournal(state, 'account', () => 1000, () => true);
  const other = new TunnelJournal(state, 'another', () => 1000, () => true);
  try {
    await first.remember(marker);
    assert.deepEqual(second.inactiveMarkers(), []);
    await assert.rejects(second.remember(marker), /another window/);
    await assert.rejects(second.forget(marker), /owner changed/);
    await first.release();
    assert.deepEqual(second.inactiveMarkers(), [marker]);
    assert.deepEqual(other.inactiveMarkers(), []);
    await second.remember(marker);
    await second.forget(marker);
    assert.equal(records.size, 0);
  } finally { await Promise.all([first.release(), second.release(), other.release()]); }
});

test('dead owners are recoverable without waiting for the lease and closed journals reject new work', async () => {
  const records = new Map();
  const state = { keys: () => [...records.keys()], get: key => records.get(key), update: async (key, value) => { records.set(key, value); } };
  const first = new TunnelJournal(state, 'account', () => 1000, () => true);
  await first.remember(marker);
  const recovery = new TunnelJournal(state, 'account', () => 1000, () => false);
  assert.deepEqual(recovery.inactiveMarkers(), [marker]);
  await recovery.remember(marker);
  await first.release();
  assert.ok([...records.values()][0].leaseUntil > 1000);
  await recovery.release();
  await assert.rejects(recovery.remember(marker), /closed/);
});
