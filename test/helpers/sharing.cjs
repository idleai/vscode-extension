const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { StdioClient } = require('../../out/host/processes');
const { MultiplayerManager: RuntimeManager } = require('@idle/history-runtime/manager');
const { SharedConnection, SharedJoin } = require('../../dist/peer-state/idle_peer_state.js');

const root = path.resolve(__dirname, '../..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const binaries = {
  peer: path.join(root, '../editchain/target/debug/editchain-peer' + suffix),
  service: path.join(root, 'target/debug/idle-editor-service' + suffix),
  engine: path.join(root, '../editchain/target/debug/editchain' + suffix),
};

class MultiplayerManager extends RuntimeManager {
  constructor(options) {
    super({ ...options, state: { joinState: () => new SharedJoin(), connectionState: () => new SharedConnection() },
      relay: options.relay ?? { host() { throw new Error('Network access is not part of this test.'); },
        client() { throw new Error('Network access is not part of this test.'); }, async remove() {} } });
  }
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-sharing-'));
  const clients = [];
  const workspace = (name, userName) => {
    const root = path.join(directory, name);
    fs.mkdirSync(root);
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root]);
    fs.writeFileSync(path.join(root, 'shared.ts'), 'Working tree stays local.\n');
    let client = new StdioClient(); client.start(binaries.service, { cwd: root }); clients.push(client);
    const session = randomUUID();
    const identity = { kind: 'unsigned', guid: randomUUID(), stream: 'a'.repeat(24) };
    let sequence = 0;
    const call = async body => {
      const response = await client.request(body, { timeoutMs: 30_000 });
      if (!response?.Ok) throw new Error(`Capture fixture: ${response?.Error?.message || 'invalid response'}`);
      return response.Ok;
    };
    const send = events => call({ RecordEditorEvents: { workspace_path: root, chain_dir: '.editchain', events:
      events.map(event => ({ schema: 1, session, identity, ...(userName ? { user_name: userName } : {}),
        sequence: ++sequence, time_ms: Date.now(), event })) } });
    const start = () => send([{ type: 'tracking_started', dwell_ms: 2000, vscode_version: '1.85.0', activity_schema: 3 },
      { type: 'workspace_context', workspace_path: root, observed_ms: Date.now(), repositories: [] }]);
    const edit = async (before, after) => {
      const document = { id: randomUUID(), uri: `file://${path.join(root, 'shared.ts')}`, path: 'shared.ts', version: 1 };
      await send([{ type: 'document_snapshot', document, text: before }]);
      const change = sequence + 1;
      return send([{ type: 'document_changed', document: { ...document, version: 2 }, before_version: 1, before, after,
        changes: [{ offset: 0, length: before.length, text: after }], reason: 'undo' },
      { type: 'human_edit', change, signal: 'undo' }]);
    };
    return { root, chain: path.join(root, '.editchain'), device: path.join(directory, `${name}-device`),
      call, start, edit, get client() { return client; }, session,
      async restart() {
        await client.shutdown(); client = new StdioClient();
        clients.push(client); client.start(binaries.service, { cwd: root });
      } };
  };
  return { directory, workspace, async stop() {
    await Promise.all(clients.map(client => client.shutdown()));
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

async function until(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
}

function blobs(chain) {
  const root = path.join(chain, 'blobs');
  return fs.existsSync(root) ? fs.readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name)).sort() : [];
}

async function query(chain, args, partial = false) {
  try {
    const { stdout } = await promisify(execFile)(binaries.engine, ['--chain', chain, '--output', 'json', ...args],
      { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (partial && error.code === 3 && error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

async function rows(local, kind) {
  if (!fs.existsSync(local.chain)) return [];
  const result = [];
  let after;
  do {
    const page = await query(local.chain, ['history', '--limit', '1000', ...(kind ? ['--kind', kind] : []), ...(after ? ['--after', after] : [])]);
    result.push(...page.items);
    after = page.next_after;
  } while (after);
  return result;
}

async function diffs(local) {
  const values = [];
  for (const row of await rows(local, 'File')) {
    const result = await query(local.chain, ['diff', row.operation.id], true);
    if (result.Found) values.push({ before: result.Found.before.value.Available, after: result.Found.after.value.Available });
  }
  return values;
}

module.exports = { fixture, binaries, until, blobs, rows, diffs, query, MultiplayerManager };
