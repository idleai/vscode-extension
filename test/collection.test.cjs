const test = require('node:test');
const assert = require('node:assert/strict');
const { CollectorLoop } = require('../out/collection/loop');

const result = (values = {}) => ({ changed: false, pending: false, written: 0, duplicates: 0, conflicts: 0, source_bytes: 0, ...values });
function fixture() {
  const failures = [];
  let changes = 0;
  const actions = {
    poll: async () => result(), observe: async () => result(),
    changed: () => { changes++; }, failed: error => failures.push(error),
  };
  return { failures, actions, changes: () => changes, loop: new CollectorLoop(actions, 60000) };
}

test('the host drains pending native batches and emits only the required refresh', async () => {
  const f = fixture();
  let pass = 0;
  f.actions.poll = async () => result({ pending: ++pass === 1, changed: pass === 1 });
  try {
    await f.loop.flush();
    assert.equal(pass, 2);
    assert.equal(f.changes(), 1);
    await f.loop.flush();
    assert.equal(pass, 3);
    assert.equal(f.changes(), 1);
  } finally { await f.loop.stopped(); }
});

test('a failed scan still reports unrelated editor or peer writes and retries', async () => {
  const f = fixture();
  let fail = true, polls = 0;
  f.actions.poll = async () => {
    polls++;
    if (fail) { fail = false; throw new Error('helper stopped'); }
    return result();
  };
  f.actions.observe = async () => result({ changed: true });
  try {
    await f.loop.flush();
    assert.equal(f.changes(), 1);
    await f.loop.flush();
    assert.equal(polls, 2);
    assert.equal(f.failures.length, 1);
  } finally { await f.loop.stopped(); }
});

test('retiring a folder cancels an active request and suppresses its delayed notification', async () => {
  const f = fixture();
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  f.actions.poll = async signal => {
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

test('retiring a folder during fallback observation suppresses its delayed notification', async () => {
  const f = fixture();
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  f.actions.poll = async () => { throw new Error('source unavailable'); };
  f.actions.observe = async signal => {
    started(signal);
    return new Promise(resolve => { release = () => resolve(result({ changed: true })); });
  };
  const pass = f.loop.flush();
  const signal = await waiting;
  f.loop.stop();
  assert.equal(signal.aborted, true);
  release();
  await pass;
  assert.equal(f.changes(), 0);
});
