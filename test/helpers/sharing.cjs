const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { StdioClient } = require('../../out/host/processes');
const { NativeProcess } = require('../../out/host/nativeProcess');
const { fixture: vscodeFixture, loadWithVSCode } = require('./vscode.cjs');
const { NativeSharing } = loadWithVSCode('../../out/sharing/runtime', vscodeFixture().api);

const root = path.resolve(__dirname, '../..');
const { binary } = require('../../scripts/native-artifacts.cjs');
const binaries = {
  peer: binary('engine', 'editchain-peer'),
  service: binary('host-tools', 'idle-editor-service'),
  engine: binary('engine', 'editchain'),
  coordinator: binary('host-tools', 'idle-coordination'),
  loopback: binary('host-tools', 'loopback-coordinator'),
};

const children = new WeakMap();
function createSharing(local, overrides = {}, production = false) {
  const key = createHash('sha256').update(local.root).digest('hex');
  const manager = new NativeSharing({ key, account: 'fixture-account', name: path.basename(local.root), cwd: local.root,
    chain: local.chain, deviceDirectory: local.device, stateDirectory: path.join(local.root, '.sharing'),
    credential: async () => { throw new Error('The loopback fixture must not request cloud credentials.'); },
    changed() {}, async saveEnabled() {}, ...overrides,
  }, root, { spawn: (_binary, args, options) => {
    const child = spawn(production ? binaries.coordinator : binaries.loopback, args, options);
    children.set(manager, child); return child;
  } });
  return manager;
}
async function crash(manager) {
  const child = children.get(manager);
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await ended;
  }
}


async function control(request) {
  let resolve, reject;
  const response = new Promise((done, failed) => { resolve = done; reject = failed; });
  const native = new NativeProcess({ frame: bytes => resolve(JSON.parse(bytes)), closed: reject });
  const timer = setTimeout(() => reject(new Error('Native fixture control timed out.')), 30_000);
  try {
    native.start(binaries.peer);
    await native.write([JSON.stringify(request)]);
    const reply = await response;
    assertNative(reply);
    return reply.result;
  } finally { clearTimeout(timer); await native.shutdown(); }
}
function assertNative(reply) {
  if (reply?.ok !== true) throw new Error('Native fixture control failed.');
}
function decode(text) { return JSON.parse(Buffer.from(text.slice('editchain:'.length), 'base64url')); }
function encode(value) { return 'editchain:' + Buffer.from(JSON.stringify(value)).toString('base64url'); }

function environment() {
  const files = fixture(), managers = new Map();
  return { files, create(local, options) {
    const manager = createSharing(local, options); managers.set(local.root, manager); return manager;
  }, async stopSharing() { await Promise.all([...managers.values()].map(manager => manager.stop())); managers.clear(); },
  async stop() { await Promise.all([...managers.values()].map(manager => manager.stop())); managers.clear(); await files.stop(); } };
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

module.exports = { fixture, binaries, until, blobs, rows, diffs, query, createSharing, control, decode, encode, environment, crash };
