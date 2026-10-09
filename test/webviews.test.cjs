const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: turn } = require('node:timers/promises');
const { fixture, view, loadWithVSCode } = require('./helpers/vscode.cjs');
const { HostEffects } = require('../out/host/effects');
const { detailTarget } = require('../out/host/viewSelection');
const f = fixture();
const { WorkspaceViewProvider } = loadWithVSCode('../../out/host/webviews', f.api);
const binding = id => ({ workspace_id: id, repository_id: `repository-${id}`, chain: `chain-${id}` });
const validate = value => {
  assert.deepEqual(value, binding(value?.workspace_id), 'all binding fields must still match');
  return value;
};

async function send(target, method, params = {}) {
  const session = target.webview.html.match(/data-host-session="([^"]+)"/)[1];
  target.messages.fire({ protocol: 1, session, id: `${method}:${target.posted.length}`, method, params });
  await turn();
}

test('native trees, Activity and detail share the latest workspace across document and extension lifetimes', async () => {
  const effects = new HostEffects(() => true);
  effects.register('host.ready', () => ({}));
  const failures = [];
  const provider = new WorkspaceViewProvider(f.context, effects, error => failures.push(error), validate);
  const changes = [];
  provider.onDidBroadcast(message => changes.push(message));
  try {
    const activity = view('idle.activity');
    provider.resolveWebviewView(activity);
    assert.ok(activity.webview.html.includes('data-view-section="Activity"'));
    await send(activity, 'host.ready');
    await provider.selectWorkspace(binding('two'));
    assert.deepEqual(activity.posted.at(-1).params, binding('two'));
    assert.deepEqual(changes.at(-1), { event: 'host.workspaceSelected', params: binding('two') });
    activity.dispose();
    await provider.selectWorkspace(binding('one'));
    const reopenedActivity = view('idle.activity');
    provider.resolveWebviewView(reopenedActivity);
    await send(reopenedActivity, 'host.ready');
    assert.deepEqual(reopenedActivity.posted.at(-1).params, binding('one'));
    assert.deepEqual(provider.selectedWorkspace, binding('one'));
    assert.deepEqual(f.context.workspaceState.get('sidebar.workspace'), binding('one'));
    provider.openTarget({ binding: binding('one'), section: 'Sessions', recorded_session: 'recorded-2' });
    const detail = f.calls.panels.at(-1);
    await send(detail, 'host.ready');
    assert.equal(detail.posted.at(-1).event, 'host.navigate');
    assert.equal(detail.posted.at(-1).params.recorded_session, 'recorded-2');
    assert.equal(detail.posted.at(-1).params.section, 'Sessions');
    assert.deepEqual(detail.posted.at(-1).params.binding, binding('one'));
    const timeline = { occurrence: `retained:${'a'.repeat(64)}`, address: { Record: { source: 'retained', record: { operation: 'a'.repeat(64), hash: 'b'.repeat(64) } } } };
    provider.openTarget({ binding: binding('one'), section: 'Activity', timeline });
    await turn();
    assert.deepEqual(detail.posted.at(-1).params.timeline, timeline, 'mini handoff preserves occurrence, source and exact stored hash');
    await send(detail, 'views.selectWorkspace', { binding: binding('two') });
    assert.deepEqual(reopenedActivity.posted.at(-1).params, binding('two'), 'detail workspace picker updates Activity');
    assert.deepEqual(changes.at(-1).params, binding('two'), 'detail workspace picker updates the native tree runtime');
    await provider.selectWorkspace(binding('one'));
    provider.openDetail('ComputeHosts');
    await turn();
    assert.equal(detail.posted.at(-1).params.section, 'ComputeHosts', 'native toolbar opens its view destination');
    await assert.rejects(effects.execute('views.openDetail', { binding: binding('two'), section: 'Activity' },
      { signal: new AbortController().signal, session: 'current' }), /selection changed/);
    assert.deepEqual(failures, []);
  } finally { provider.dispose(); }
  const reopened = new WorkspaceViewProvider(f.context, effects, error => failures.push(error), validate);
  try {
    const target = view('idle.activity');
    reopened.resolveWebviewView(target);
    await send(target, 'host.ready');
    assert.deepEqual(target.posted.at(-1).params, binding('one'));
  } finally { reopened.dispose(); effects.dispose(); }
});

test('detail routing only accepts typed destinations and rechecks the full repository binding', () => {
  assert.throws(() => detailTarget({ binding: binding('one'), section: 'RunCommand' }, validate), /destination/);
  assert.throws(() => detailTarget({ binding: { ...binding('one'), chain: 'replaced' }, section: 'Activity' }, validate), /binding fields/);
  assert.throws(() => detailTarget({ binding: binding('one'), section: 'Sessions', session: {} }, validate), /selection/);
  assert.throws(() => detailTarget({ binding: binding('one'), section: 'Sessions', recorded_session: {} }, validate), /selection/);
  assert.throws(() => detailTarget({ binding: binding('one'), section: 'Activity', history: 'x' }, validate), /history selection/);
  assert.deepEqual(detailTarget({ binding: binding('one'), section: 'Activity', history: { item: 'item-2' } }, validate).history, { item: 'item-2', observation: null });
  assert.throws(() => detailTarget({ binding: binding('one'), section: 'Activity', timeline: { occurrence: 'current:x', address: { Record: { source: 'current', record: { operation: 'x', hash: 'y' } } } } }, validate), /record/);
});

test('startup selects the current folder, preserves an explicit choice, and replaces a removed binding', async () => {
  const effects = new HostEffects(() => true);
  const failures = [];
  const valid = new Set(['one', 'two']);
  await f.context.workspaceState.update('sidebar.workspace', undefined);
  const provider = new WorkspaceViewProvider(f.context, effects, error => failures.push(error), value => {
    validate(value);
    assert.ok(valid.has(value.workspace_id));
    return value;
  }, () => binding('one'));
  try {
    assert.deepEqual(provider.ensureWorkspace(), binding('one'));
    assert.deepEqual(f.context.workspaceState.get('sidebar.workspace'), binding('one'));
    await provider.selectWorkspace(binding('two'));
    assert.deepEqual(provider.ensureWorkspace(), binding('two'), 'an explicit choice wins over the active editor');
    valid.delete('two');
    assert.deepEqual(provider.ensureWorkspace(), binding('one'), 'a removed saved folder falls back to the current folder');
    assert.deepEqual(failures, []);
  } finally { provider.dispose(); effects.dispose(); }
});
