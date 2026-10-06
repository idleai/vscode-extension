const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: turn } = require('node:timers/promises');
const { fixture, loadWithVSCode } = require('./helpers/vscode.cjs');
const { HostEffects } = require('../out/host/effects');
const f = fixture();
const { WorkspaceViewProvider } = loadWithVSCode('../../out/host/webviews', f.api);
const { NativeSidebar } = loadWithVSCode('../../out/host/nativeSidebar', f.api);
const { NativeTree } = loadWithVSCode('../../out/host/nativeTrees', f.api);

const row = (id, label) => ({ id, label, description: 'main', tooltip: `${label}\nRecorded host`,
  icon: 'server', color: 'charts.green', context: 'idle.item', actionable: true, selected: false });

test('native tree delegates row controls to VS Code, preserves identities, and filters loaded records', async () => {
  const tree = new NativeTree('idle.computeHosts', async () => {});
  try {
    let changes = 0;
    tree.onDidChangeTreeData(() => changes++);
    const rows = Array.from({ length: 1200 }, (_, index) => row(`host-${index}`, `Host ${index}`));
    tree.update(rows);
    const item = tree.getTreeItem(rows[1199]);
    assert.equal((await tree.getChildren()).length, 1200);
    assert.equal(item.id, 'host-1199');
    assert.equal(item.collapsibleState, f.api.TreeItemCollapsibleState.None);
    assert.deepEqual(item.command, { command: 'idle.sidebar.activate', title: 'Open', arguments: ['host-1199'] });
    assert.equal(item.iconPath.id, 'server');
    assert.equal(item.iconPath.color.id, 'charts.green');
    tree.update(structuredClone(rows));
    assert.equal(changes, 1, 'unchanged snapshots leave native selection and scroll untouched');
    tree.setFilter('1199');
    assert.deepEqual((await tree.getChildren()).map(row => row.id), ['host-1199']);
    tree.setFilter('');
    assert.equal((await tree.getChildren()).length, 1200);
    tree.update([row('host-1199', 'Renamed')]);
    assert.equal(tree.getTreeItem((await tree.getChildren())[0]).id, item.id);
    assert.equal(tree.getTreeItem({ ...rows[0], actionable: false }).command, undefined);
  } finally { tree.dispose(); }
});

test('native runtime survives hidden views, clears rows on context change, and rejects late host replies', async () => {
  const effects = new HostEffects(() => true);
  effects.register('host.ready', () => ({}));
  const pending = [];
  effects.register('test.directory', (_, { signal }) => new Promise(resolve => pending.push({ resolve, signal })));
  const errors = [];
  const webviews = new WorkspaceViewProvider(f.context, effects, error => errors.push(error), value => value);
  const inputs = [];
  let next = 0, records = [], freed = 0;
  const rust = {
    update(raw) {
      const input = JSON.parse(raw);
      inputs.push(input);
      const calls = [];
      if (input.type === 'Reset') records = [];
      if (input.type === 'Ready') calls.push({ id: `request-${++next}`, method: 'test.directory', params: {} });
      if (input.type === 'Reply') records = [row('record', input.value.result.Ok)];
      return JSON.stringify({ trees: [{ id: 'idle.workspace', rows: records }], calls, selection: null, detail: null });
    },
    free() { freed++; },
  };
  const sidebar = new NativeSidebar(f.context, effects, webviews, error => errors.push(error), () => rust);
  const tree = f.calls.trees.findLast(tree => tree.id === 'idle.workspace');
  try {
    await tree.treeDataProvider.getChildren();
    assert.equal(pending.length, 1);
    pending[0].resolve('First account');
    await turn();
    assert.equal((await tree.treeDataProvider.getChildren())[0].label, 'First account');
    tree.visible = false;
    webviews.broadcast('host.configurationChanged', {});
    assert.deepEqual(records, [], 'old account data is hidden immediately');
    await turn();
    assert.equal(pending.length, 2);
    webviews.broadcast('host.configurationChanged', {});
    await turn();
    assert.equal(pending[1].signal.aborted, true);
    pending[1].resolve('Retired account');
    pending[2].resolve('Current account');
    await turn();
    assert.equal((await tree.treeDataProvider.getChildren())[0].label, 'Current account');
    assert.ok(!inputs.some(input => input.type === 'Reply' && input.value.result.Ok === 'Retired account'));
    await sidebar.refresh('Sessions');
    assert.deepEqual(inputs.at(-1), { type: 'Refresh', value: 'Sessions' });
    assert.deepEqual(errors, []);
  } finally { sidebar.dispose(); webviews.dispose(); effects.dispose(); }
  assert.equal(freed, 1);
  assert.equal(tree.disposed, true);
});
