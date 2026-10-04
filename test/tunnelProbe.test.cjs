'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, createSharing } = require('./helpers/sharing.cjs');

test('the native relay journal persists private owner markers once and rejects invalid batches before changing them', async () => {
  const files = fixture(), local = files.workspace('journal');
  const manager = createSharing(local, { credential: async () => undefined }, true);
  const marker = 'idle-relay-' + 'b'.repeat(24);
  try {
    await manager.importCleanup([marker]); await manager.importCleanup([marker]);
    const file = path.join(local.root, '.sharing/state/relay-journal.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).map(entry => entry.marker), [marker]);
    const previous = fs.readFileSync(file);
    await assert.rejects(manager.importCleanup(['idle-relay-' + 'c'.repeat(24), 'invalid-marker']), { code: 'invalid_request' });
    assert.deepEqual(fs.readFileSync(file), previous);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    await assert.rejects(manager.cleanup());
    assert.deepEqual(fs.readFileSync(file), previous, 'uncertain cloud cleanup retains all ownership details');
  } finally { await manager.suspend().catch(() => {}); await files.stop(); }
});
