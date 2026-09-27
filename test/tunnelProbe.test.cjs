'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Duplex, PassThrough } = require('node:stream');
const { CancellationToken } = require('vscode-jsonrpc');
const { ProbeJournal, exchange } = require('../scripts/smoke-dev-tunnels.cjs');

test('live probe recovery retains forgotten ownership until independent cloud verification', async () => {
  const journal = ProbeJournal.create();
  const marker = `idle-relay-${'a'.repeat(24)}`;
  try {
    await journal.remember(marker);
    assert.deepEqual([...ProbeJournal.load(journal.file).pending], [marker]);
    await journal.forget(marker);
    const recovered = ProbeJournal.load(journal.file);
    assert.deepEqual([...recovered.markers], [marker]);
    assert.equal(recovered.pending.size, 0);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(journal.file, 'utf8'))), ['version', 'markers', 'pending']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(journal.file).mode & 0o777, 0o600);
    await assert.rejects(journal.remember('invalid-resource'));
  } finally { journal.remove(); }
  assert.equal(fs.existsSync(journal.file), false);
});

test('live probe recovery rejects corrupt ownership and never deletes sibling files', () => {
  const journal = ProbeJournal.create();
  const sibling = path.join(path.dirname(journal.file), 'unrelated');
  fs.writeFileSync(sibling, 'keep');
  try {
    fs.writeFileSync(journal.file, JSON.stringify({ version: 1, markers: [], pending: [`idle-relay-${'b'.repeat(24)}`] }));
    assert.throws(() => ProbeJournal.load(journal.file), /Invalid probe/);
    journal.remove();
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep');
  } finally {
    fs.unlinkSync(sibling);
    fs.rmdirSync(path.dirname(journal.file));
  }
});

function wires() {
  const a = new PassThrough(), b = new PassThrough();
  const pair = [Duplex.from({ readable: a, writable: b }), Duplex.from({ readable: b, writable: a })];
  for (const stream of pair) stream.on('error', error => assert.equal(error.code, 'ABORT_ERR'));
  return pair;
}

function closePair(pair) {
  return Promise.all(pair.map(stream => new Promise(resolve => {
    if (stream.closed) resolve(); else stream.once('close', resolve);
    stream.destroy();
  })));
}

test('live probe checks all synthetic bytes under bidirectional backpressure', async () => {
  const [a, b] = wires();
  try { await exchange(a, b, CancellationToken.None, 1000); }
  finally { await closePair([a, b]); }
});

test('live probe rejects corrupted bytes and closes both streams', async () => {
  const [a, b] = wires();
  b.write(Buffer.from('corrupt'));
  await assert.rejects(exchange(a, b, CancellationToken.None, 1000), /Synthetic byte transfer failed/);
  assert.equal(a.destroyed, true);
  assert.equal(b.destroyed, true);
  await closePair([a, b]);
});
