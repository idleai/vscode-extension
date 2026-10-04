'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, createSharing, decode } = require('./helpers/sharing.cjs');

// SDK ownership, pin validation, cleanup and transport recovery run in the Rust
// suite invoked by prepare-host-tests. These checks cover the actual host boundary.
test('opening native sharing for a public join request stays offline and writes no credential to configuration', async () => {
  const files = fixture(), local = files.workspace('offline');
  let callbacks = 0;
  const manager = createSharing(local, { credential: async () => { callbacks++; return 'private-owner-token'; } }, true);
  try {
    assert.equal(fs.existsSync(path.join(local.root, '.sharing')), false);
    const request = decode(await manager.joinRequest());
    assert.match(request.device.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(callbacks, 0);
    const configuration = fs.readFileSync(path.join(local.root, '.sharing/host.json'), 'utf8');
    assert.equal(configuration.includes('private-owner-token'), false);
    assert.equal(JSON.parse(configuration).host_credentials, true);
    assert.equal(JSON.parse(configuration).credential_variable, null);
    assert.equal(manager.status().enabled, false);
  } finally { await manager.suspend(); await files.stop(); }
});

test('imported cleanup records survive denied credentials and startup remains usable', async () => {
  const files = fixture(), local = files.workspace('pending');
  const callbacks = [], statuses = [];
  const options = { credential: async purpose => { callbacks.push(purpose); throw new Error('private provider diagnostic'); }, changed: value => statuses.push(value) };
  let manager = createSharing(local, options, true);
  try {
    await manager.importCleanup(['idle-relay-' + 'a'.repeat(24)]);
    await assert.rejects(manager.cleanup(), error => !error.message.includes('private'));
    assert.ok(callbacks.includes('management'));
    const file = path.join(local.root, '.sharing/state/relay-journal.json');
    assert.equal(JSON.parse(fs.readFileSync(file)).length, 1);
    await manager.suspend().catch(() => {});
    manager = createSharing(local, options, true);
    const request = decode(await manager.joinRequest());
    assert.ok(request.device.fingerprint, 'startup cleanup callbacks must not block native framing');
    assert.equal(JSON.parse(fs.readFileSync(file)).length, 1, 'failed cleanup remains durable after reopening');
    assert.equal(JSON.stringify(statuses).includes('private provider diagnostic'), false);
    await assert.rejects(manager.importCleanup(['unrelated-marker']), { code: 'invalid_request' });
  } finally { await manager.suspend().catch(() => {}); await files.stop(); }
});
