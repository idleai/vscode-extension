const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StdioClient } = require('../out/host/processes');
const { NativeHost } = require('../out/host/nativeHost');

/** Exercise the packaged collector and exporter against isolated source files. */
async function smokeCollection(directory) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-native-collection-'));
  const clients = [];
  const binary = name => path.join(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  let processes = 0;
  const native = new NativeHost(() => binary('idle-host'), { spawn: (...args) => { processes++; return spawn(...args); } });
  function start(name, binding) {
    const client = new StdioClient({}, native.connection(root, name, binding));
    client.ensureStarted();
    clients.push(client);
    return client;
  }
  async function request(client, body) {
    const response = await client.request(body, { timeoutMs: 60000 });
    assert.ok(response.Ok, JSON.stringify(response.Err));
    return response.Ok;
  }
  try {
    execFileSync('git', ['init', '--quiet', root]);
    const sessions = path.join(root, 'sessions');
    const chain = path.join(root, 'chain');
    await fs.mkdir(sessions);
    const source = path.join(sessions, 'rollout-2026-09-21T12-00-00-22222222-2222-7222-8222-222222222222.jsonl');
    const fixture = await fs.readFile(require('./native-artifacts.cjs').artifact('host-tools', 'fixtures', 'rollout-contract.jsonl'), 'utf8');
    const lines = fixture.trimEnd().split('\n');
    const metadata = JSON.parse(lines[0]);
    metadata.payload.cwd = root;
    lines[0] = JSON.stringify(metadata);
    await fs.writeFile(source, lines.join('\n') + '\n');
    const binding = { workspace: root, chain, sessions, helper: binary('codex-session-exporter') };
    let collector = start('collection', binding);
    const scan = async () => {
      let total = 0;
      let changed = false;
      for (let pass = 0; pass < 100; pass++) {
        const update = await request(collector, { scan: 'import' });
        total += update.written;
        changed ||= update.changed;
        if (!update.pending) return { written: total, changed };
      }
      throw new Error('Collector did not finish the bounded source fixture.');
    };
    assert.ok((await scan()).written > 0, 'the packaged exporter supplies durable history');
    const repository = { workspace_id: 'collection', repository_id: 'repository', chain: 'history' };
    const history = start('history', { repository, chain_directory: chain, retained_directory: null });
    const read = async () => {
      const observations = [];
      let after = null;
      do {
        const result = await request(history, { binding: repository, query: { chain: repository.chain, action: {
          History: { filter: { kinds: [], session: null, author: null, recorder: null, path: null }, page: { after, limit: 100 } },
        } } });
        observations.push(...result.History.observations);
        after = result.History.next_after;
      } while (after);
      return observations;
    };
    const originals = async observations => {
      const values = new Set();
      for (const observation of observations) {
        const operation = JSON.parse(Buffer.from(observation.operation_json).toString('utf8'));
        assert.ok(Object.hasOwn(operation, 'recorder'), 'collector writes schema-three records');
        const result = await history.request({ binding: repository, source: 'current', record: observation.record, target: 'Original' });
        for (const document of result.Ok?.documents ?? []) values.add(Buffer.from(document.bytes).toString('utf8'));
      }
      return values;
    };
    const initial = await read();
    assert.ok((await originals(initial)).has(lines[2] + '\n'), 'Original drill-down retains exact source JSON, including its line ending');
    assert.deepEqual(await scan(), { written: 0, changed: false }, 'unchanged source is idempotent');
    await collector.shutdown();
    collector = start('collection', binding);
    assert.equal((await scan()).written, 0, 'restart uses durable source cursors');
    assert.deepEqual(await read(), initial, 'restart preserves every stored reference');
    const appended = JSON.stringify({ timestamp: '2026-09-21T12:00:07.000Z', type: 'response_item', payload: {
      type: 'message', id: 'msg_after_restart', role: 'assistant', content: [{ type: 'output_text', text: 'Appended after restart.' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
    } });
    await fs.appendFile(source, appended + '\n');
    assert.ok((await scan()).written > 0, 'append resumes the live projection');
    const appendedHistory = await read();
    assert.ok(appendedHistory.length > initial.length);
    assert.ok((await originals(appendedHistory)).has(appended + '\n'));
    const rewritten = appended.replace('Appended after restart.', 'Rewritten source generation.');
    await fs.writeFile(source + '.replacement', [...lines, rewritten].join('\n') + '\n');
    await fs.rename(source + '.replacement', source);
    assert.ok((await scan()).written > 0, 'source rewrites retain a new generation');
    const retained = await originals(await read());
    assert.ok(retained.has(appended + '\n') && retained.has(rewritten + '\n'),
      `rewrites retain both original inputs (old=${retained.has(appended + '\n')}, new=${retained.has(rewritten + '\n')}, originals=${retained.size})`);
    assert.equal(processes, 1, 'collection and history keep one host process across channel restart');
    console.log('PASS: packaged collection/exporter import, unchanged replay, channel restart, append, rewrite generations and exact Original bytes in one host.');
  } finally {
    await Promise.all(clients.map(client => client.shutdown()));
    await native.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}

module.exports = { smokeCollection };
if (require.main === module) {
  smokeCollection(path.resolve(process.argv[2] ?? `bin/${process.platform}-${process.arch}`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
