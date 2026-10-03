const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CollectorLoop } = require('../out/collection/loop');
const { captureSources, belongsToWorkspace } = require('../out/collection/sources');

const result = (values = {}) => ({ changed: false, pending: false, written: 0, duplicates: 0, conflicts: 0, source_bytes: 0, ...values });
function fixture() {
  const source = { files: new Map([['a', '1']]), git: 'git1', titles: 'titles1' };
  const calls = [], failures = [];
  let changes = 0;
  const actions = {
    capture: async () => ({ ...source, files: new Map(source.files) }), select: async files => files,
    poll: async (paths, git) => { calls.push({ paths, git }); return result(); },
    changed: () => { changes++; }, failed: error => failures.push(error),
  };
  return { source, calls, failures, actions, changes: () => changes, loop: new CollectorLoop(actions, 60000) };
}

test('bounded pending passes complete before stamps advance, including an append during the pass', async () => {
  const f = fixture();
  let pass = 0;
  f.actions.poll = async (paths, git) => {
    f.calls.push({ paths, git });
    if (++pass === 1) { f.source.files.set('a', '2'); return result({ pending: true, changed: true }); }
    return result();
  };
  try {
    await f.loop.flush();
    await f.loop.flush();
    await f.loop.flush();
    assert.deepEqual(f.calls, [
      { paths: ['a'], git: true }, { paths: ['a'], git: false },
      { paths: ['a'], git: false }, { paths: [], git: false },
    ]);
    assert.equal(f.changes(), 1);
  } finally { await f.loop.stopped(); }
});

test('a failed import retries the same source and still reports unrelated editor or peer writes', async () => {
  const f = fixture();
  let fail = true;
  f.actions.poll = async (paths, git) => {
    f.calls.push({ paths, git });
    if (paths.length && fail) { fail = false; throw new Error('helper stopped'); }
    return result({ changed: !paths.length });
  };
  try {
    await f.loop.flush();
    assert.equal(f.changes(), 1);
    await f.loop.flush();
    assert.deepEqual(f.calls.map(call => call.paths), [['a'], [], ['a']]);
    assert.equal(f.failures.length, 1);
  } finally { await f.loop.stopped(); }
});

test('title changes revisit every source in batches and do not starve older files', async () => {
  const f = fixture();
  f.source.files = new Map(Array.from({ length: 70 }, (_, i) => [`file${i}`, '1']));
  try {
    for (let i = 0; i < 4; i++) await f.loop.flush();
    assert.deepEqual(f.calls.map(call => call.paths.length), [32, 32, 6, 0]);
    f.source.titles = 'titles2';
    for (let i = 0; i < 4; i++) await f.loop.flush();
    assert.deepEqual(f.calls.slice(4).map(call => call.paths.length), [32, 32, 6, 0]);
    assert.equal(new Set(f.calls.slice(4).flatMap(call => call.paths)).size, 70);
  } finally { await f.loop.stopped(); }
});

test('retiring a folder cancels an active request and suppresses its delayed notification', async () => {
  const f = fixture();
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  f.actions.poll = async (_paths, _git, signal) => {
    started(signal);
    return new Promise(resolve => { release = () => resolve(result({ changed: true, pending: true })); });
  };
  const pass = f.loop.flush();
  const signal = await waiting;
  f.loop.stop();
  assert.equal(signal.aborted, true);
  release();
  await pass;
  await f.loop.flush();
  assert.equal(f.changes(), 0);
});

test('discovery detects rewrites and linked-worktree refs, excludes foreign roots and directory symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-collection-'));
  const workspace = path.join(root, 'repo'), sessions = path.join(root, 'sessions');
  const metadata = path.join(root, 'git', 'worktrees', 'repo'), common = path.join(root, 'git');
  try {
    await Promise.all([workspace, sessions, metadata, path.join(common, 'refs', 'heads')].map(dir => fs.mkdir(dir, { recursive: true })));
    await fs.writeFile(path.join(workspace, '.git'), `gitdir: ${metadata}\n`);
    await fs.writeFile(path.join(metadata, 'commondir'), '../..\n');
    await fs.writeFile(path.join(metadata, 'HEAD'), 'ref: refs/heads/main\n');
    const ref = path.join(common, 'refs', 'heads', 'main');
    await fs.writeFile(ref, 'a');
    const source = path.join(sessions, 'rollout-one.jsonl');
    const header = cwd => JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n';
    await fs.writeFile(source, header(workspace));
    await fs.mkdir(path.join(sessions, 'nested'));
    await fs.symlink(sessions, path.join(sessions, 'nested', 'cycle'), 'dir');
    const before = await captureSources(workspace, sessions, true);
    assert.equal(before.files.size, 1);
    assert.equal(await belongsToWorkspace(source, workspace), true);
    await fs.writeFile(source, header(root));
    await fs.writeFile(ref, 'b');
    const after = await captureSources(workspace, sessions, true);
    assert.notEqual(after.files.get(source), before.files.get(source));
    assert.notEqual(after.git, before.git);
    assert.equal(await belongsToWorkspace(source, workspace), false);
    const nested = path.join(workspace, 'nested', '.git');
    await fs.mkdir(path.join(nested, 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(nested, 'HEAD'), 'ref: refs/heads/main\n');
    const nestedRef = path.join(nested, 'refs', 'heads', 'main');
    await fs.writeFile(nestedRef, 'first');
    const discovered = await captureSources(workspace, sessions, false);
    assert.notEqual(discovered.git, after.git, 'a new nested repository schedules reconciliation');
    await fs.writeFile(nestedRef, 'second');
    assert.notEqual((await captureSources(workspace, sessions, false)).git, discovered.git,
      'nested repository commits refresh links without a new rollout record');
    assert.equal((await captureSources(workspace, sessions, false)).files.size, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
