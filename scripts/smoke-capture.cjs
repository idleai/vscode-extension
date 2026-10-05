const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StdioClient } = require('../out/host/processes');
const { NativeHost } = require('../out/host/nativeHost');
const { EditorOutbox } = require('../out/capture/editorOutbox');
const { HistoryArchive } = require('../out/capture/historyArchive');

/** Exercise packaged IPC and storage using only a temporary synthetic checkout. */
async function smokeCapture(binary) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-native-capture-'));
  const journal = path.join(directory, 'outbox');
  const archive = new HistoryArchive({ directory: path.join(directory, 'archive'), log() {}, report(message) { throw new Error(message); } });
  const native = new NativeHost(() => binary);
  const connect = native.connection(directory, 'capture', { workspace_path: directory, chain_dir: path.join(directory, '.editchain') });
  let client = new StdioClient({}, connect);
  let outbox;
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    execFileSync('git', ['-C', directory, '-c', 'user.name=Capture Test', '-c', 'user.email=capture@example.invalid',
      '-c', 'commit.gpgSign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Capture fixture']);
    client.ensureStarted();
    const context = await client.request({ GetEditorContext: { workspace_path: directory, chain_dir: '.editchain' } }, { timeoutMs: 30000 });
    assert.ok(context.Ok.repositories.some(repository => repository.head?.length === 40 && repository.root === directory));
    const session = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const identity = { kind: 'unsigned', guid: '22222222-2222-4222-8222-222222222222', stream: 'a'.repeat(24) };
    const units = { offsets: 'utf16_code_units', positions: 'zero_based_line_utf16_column', snapshots: 'utf8_bytes' };
    const event = (sequence, event) => ({ schema: 1, session, sequence, time_ms: sequence * 1000, identity, units, event });
    const document = version => ({ id: 'buffer', uri: `file://${directory}/unsaved.ts`, path: 'unsaved.ts', version });
    const events = [event(1, { type: 'tracking_started', dwell_ms: 500, vscode_version: '1.85.0', activity_schema: 3 }),
      event(2, { type: 'workspace_context', ...context.Ok }),
      event(3, { type: 'document_snapshot', document: document(1), text: 'a😀\r\nz' }),
      event(4, { type: 'document_changed', document: document(2), before_version: 1, before: 'a😀\r\nz', after: 'aé\r\nz',
        changes: [{ offset: 1, length: 2, text: 'é' }], reason: null }),
      event(5, { type: 'human_edit_batch', group: 4, edits: [{ change: 4, signal: 'keyboard_selection' }] }),
      event(6, { type: 'code_read', document: document(2), editor: '1', ranges: [{ start: [0, 1], end: [0, 2] }], started_ms: 5500, duration_ms: 500 })];
    const count = 10001;
    const multi = version => ({ ...document(version), id: 'multi', path: 'multi.ts', uri: `file://${directory}/multi.ts` });
    const before = '😀'.repeat(count), after = '😀x'.repeat(count);
    events.push(event(7, { type: 'document_snapshot', document: multi(1), text: before }),
      event(8, { type: 'document_changed', document: multi(2), before_version: 1, before, after, reason: null,
        changes: Array.from({ length: count }, (_, index) => ({ offset: 2 * (count - index), length: 0, text: 'x' })) }),
      event(9, { type: 'document_saved', document: multi(2) }));
    let lost = false;
    outbox = new EditorOutbox(journal, directory, '.editchain', async parts => {
      if (lost) throw new Error('offline after lost acknowledgement');
      const response = await client.requestJson(parts, { timeoutMs: 30000 });
      assert.equal(response.Ok.operation_schema, 3);
      assert.equal(response.Ok.accepted, events.length);
      lost = true;
      throw new Error('simulated lost acknowledgement');
    }, () => {}, () => {}, () => {}, (workspace, value, raw) => archive.append(workspace, value, raw));
    for (const value of events) assert.equal(outbox.push(value), true);
    assert.equal(await outbox.flush(), false);
    assert.ok((await fs.readdir(journal)).some(name => name.endsWith('.json')));
    await outbox.stop(); await client.shutdown();
    client = new StdioClient({}, connect);
    const responses = [];
    outbox = new EditorOutbox(journal, directory, '.editchain', async parts => {
      client.ensureStarted();
      const response = await client.requestJson(parts, { timeoutMs: 30000 });
      responses.push(response); return response;
    }, () => {}, () => {}, () => {}, (workspace, value, raw) => archive.append(workspace, value, raw));
    const fresh = { ...events[0], session: '00000000-0000-4000-8000-000000000000' };
    assert.equal(outbox.push(fresh), true);
    assert.equal(await outbox.flush(), true);
    assert.equal(responses[0].Ok.replayed, events.length, 'restart retries exact durable events before a new session');
    assert.equal(responses.at(-1).Ok.accepted, 1);
    assert.deepEqual(await fs.readdir(journal), []);
    await archive.stop();
    const lines = (await fs.readFile(archive.location, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(line => line.event), [...events, fresh], 'raw archive is independent of acknowledgement loss');
    await assert.rejects(fs.readFile(path.join(directory, 'unsaved.ts')), { code: 'ENOENT' });
    console.log('PASS: native schema-three capture, Git context, unsaved Unicode, 10,001 replacements, raw archive and ordered recovery after a lost acknowledgement.');
  } finally {
    await outbox?.stop(); await client.shutdown(); await archive.stop();
    await native.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { smokeCapture };
if (require.main === module) {
  const binary = process.argv[2] ?? require('./native-artifacts.cjs').binary('host-tools', 'idle-host');
  smokeCapture(binary).catch(error => { console.error(error); process.exitCode = 1; });
}
