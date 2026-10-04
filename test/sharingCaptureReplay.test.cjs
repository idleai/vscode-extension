'use strict';

// Peer receipts must not erase the recorder's authored baseline after a process restart.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { environment, control, until, blobs, diffs, rows, query } = require('./helpers/sharing.cjs');

const live = manager => manager.status().peers.filter(peer => peer.state === 'Live').length;
const ledger = chain => JSON.parse(fs.readFileSync(path.join(chain, 'multiplayer/scope.json'), 'utf8'));
const keyOf = entry => JSON.stringify([entry.id, entry.digest]);

function recorder(local) {
  const identity = { kind: 'unsigned', guid: '11111111-1111-4111-8111-111111111111', stream: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
  const session = randomUUID();
  const document = { id: 'buffer', uri: `file://${path.join(local.root, 'shared.ts')}`, path: 'shared.ts', version: 1 };
  let sequence = 0;
  const send = async events => {
    const response = await local.client.request({ RecordEditorEvents: { workspace_path: local.root, chain_dir: '.editchain',
      events: events.map(event => ({ schema: 1, session, sequence: ++sequence, time_ms: 1000 + sequence, identity, event })) } },
    { timeoutMs: 30_000 });
    if (!response?.Ok) throw new Error(`record failed: ${response?.Error?.code || 'invalid_response'}`);
    return response.Ok;
  };
  const changed = async (before, after, version) => {
    const change = sequence + 1;
    return send([
      { type: 'document_changed', document: { ...document, version }, before_version: version - 1, before, after,
        changes: [{ offset: 0, length: before.length, text: after }], reason: 'undo' },
      { type: 'human_edit', change, signal: 'undo' },
    ]);
  };
  return { document, send, changed };
}

for (const policy of ['legacy', 'cutoff']) test(`a peer-supplied copy of a withheld baseline cannot erase recorder state on a cold rebuild (${policy})`, { timeout: 90_000 }, async () => {
  const env = environment();
  const a = env.files.workspace('a'), b = env.files.workspace('b');
  try {
    const author = recorder(a);
    await author.send([{ type: 'tracking_started', dwell_ms: 2000, vscode_version: '1.137.0', activity_schema: 3 },
      { type: 'workspace_context', workspace_path: a.root, observed_ms: 1000, repositories: [] }]);
    await author.send([{ type: 'document_snapshot', document: author.document, text: 'baseline\n' }]);
    await author.changed('baseline\n', 'baseline revised\n', 2);

    // Only the pre-sharing durable chain travels: segments and content blobs,
    // never this device's keys or its disposable derived cache.
    fs.mkdirSync(b.chain, { recursive: true });
    fs.cpSync(a.chain, b.chain, { recursive: true, filter: source => path.basename(source) !== 'index-v3' });
    const copiedBlobs = blobs(b.chain);
    assert.ok(copiedBlobs.length > 0, 'the copied baseline must carry content blobs');
    const baselineRecords = (await query(a.chain, ['integrity'])).chain.records;

    // Local work recorded after the copy stays private to this device.
    await author.changed('baseline revised\n', 'private draft\n', 3);

    const host = env.create(a), guest = env.create(b);
    // Exercise both the persisted legacy boundary and migration to an explicit cutoff.
    await control({ type: 'configure', chain_dir: a.chain, space: 'capture-sharing-space', backfill: false });
    const withheld = ledger(a.chain).excluded.map(keyOf);
    const invitation = await host.hostHistory(await guest.joinRequest(), policy === 'legacy' ? 'keep' : false);
    assert.ok(withheld.length > 0, 'sharing only new history must withhold the authored baseline');
    assert.equal(ledger(a.chain).received.length, 0, 'nothing has been supplied by the peer yet');
    await guest.joinHistory(invitation, true);

    await until(() => {
      const scope = ledger(a.chain);
      return live(host) === 1 && live(guest) === 1 && scope.received.length === baselineRecords
        && scope.received_blobs.length === copiedBlobs.length
        && (policy === 'cutoff' || scope.received.length + scope.excluded.length === withheld.length);
    }, 'the peer never supplied the independently copied baseline');

    // Every record the peer held was delivered back as an exact receipt, while
    // the post-copy local work stayed withheld.
    const scope = ledger(a.chain);
    assert.ok(scope.received.map(keyOf).every(key => withheld.includes(key)), 'every receipt must match withheld baseline records');
    assert.equal(scope.received.length, baselineRecords, 'the peer must supply its complete independently copied baseline');
    if (policy === 'legacy') assert.ok(scope.excluded.length > 0, 'the withheld local work must not be published by receiving a copy of it');
    else {
      assert.ok(scope.cutoff.first_segment > 0, 'the append cutoff remains in force after receipts');
      assert.equal(host.status().peers[0].progress.outgoing.total_records, 0, 'independent receipts cannot re-export pre-cutoff work');
    }
    assert.equal(scope.received_blobs.length, copiedBlobs.length, 'only peer-supplied content may become publishable');
    assert.deepEqual(blobs(b.chain), copiedBlobs, 'the exchange must not publish withheld local blobs to the peer');
    await env.stopSharing();

    const quarantined = (await query(a.chain, ['integrity'])).chain.quarantined;
    await a.restart();
    const resumed = await author.send([{ type: 'code_read', document: { ...author.document, version: 3 }, editor: 'view',
      ranges: [{ start: [0, 0], end: [0, 7] }], started_ms: 9000, duration_ms: 3000 }]);
    assert.equal(resumed.accepted, 1);
    assert.equal((await query(a.chain, ['integrity'])).chain.quarantined, quarantined,
      'replaying the recorder cannot create conflicting operations');
    const recorded = await rows(a, 'File');
    const read = recorded.find(row => row.operation.kind.File?.action === 'Read');
    assert.ok(read, 'reading the withheld revision survives a fresh capture process');
    const parent = recorded.find(row => row.operation.kind.File?.action === 'Change' &&
      row.operation.kind.File.revision === read.operation.kind.File.revision);
    assert.ok(parent, 'the read identifies the exact prior buffer revision');
    assert.ok(read.operation.parents.includes(parent.operation.id), 'the read retains its recorded revision parent');
    const content = await query(a.chain, ['content', read.operation.id, '--field', 'FileAfter']);
    assert.equal(content.Found.value.Available, 'private draft\n');
    const history = await diffs(a);
    assert.ok(history.some(diff => diff.before === 'baseline\n' && diff.after === 'baseline revised\n'), 'authored baseline diff must resolve');
    assert.ok(history.some(diff => diff.before === 'baseline revised\n' && diff.after === 'private draft\n'), 'withheld local diff must resolve');
  } finally { await env.stopSharing(); await env.stop(); }
});
