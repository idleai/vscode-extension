const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fixture, view, uri, loadWithVSCode } = require('./helpers/vscode.cjs');
const f = fixture();
const extra = ['open', 'close', 'change', 'save', 'rename', 'visible', 'viewport', 'selection', 'focus', 'tabs'];
for (const name of extra) f.events[name] = new f.api.EventEmitter();
Object.assign(f.api, {
  version: '1.85.0', ConfigurationTarget: { Workspace: 2 },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 }, TextEditorSelectionChangeKind: { Keyboard: 1 },
  TabInputText: class { constructor(uri) { this.uri = uri; } },
});
Object.assign(f.api.workspace, {
  textDocuments: [], onDidOpenTextDocument: f.events.open.event, onDidCloseTextDocument: f.events.close.event,
  onDidChangeTextDocument: f.events.change.event, onDidSaveTextDocument: f.events.save.event,
  onDidRenameFiles: f.events.rename.event,
  getConfiguration: (_, resource) => ({
    get: (key, fallback) => f.configuration.get(resource?.toString())?.[key] ?? f.configuration.get(undefined)?.[key] ?? fallback,
    update: async (key, value) => {
      f.configuration.set(undefined, { ...f.configuration.get(undefined), [key]: value });
      f.events.configuration.fire({ affectsConfiguration: section => section === 'idle' || `idle.${key}`.startsWith(section) });
    },
  }),
});
Object.assign(f.api.window, {
  state: { focused: true }, visibleTextEditors: [],
  onDidChangeVisibleTextEditors: f.events.visible.event, onDidChangeTextEditorVisibleRanges: f.events.viewport.event,
  onDidChangeTextEditorSelection: f.events.selection.event, onDidChangeWindowState: f.events.focus.event,
  tabGroups: { all: [], onDidChangeTabs: f.events.tabs.event },
});
const extension = loadWithVSCode('../../out/extension', f.api);
const { StdioClient } = require('../out/host/processes');
const original = Object.fromEntries(['ensureStarted', 'request', 'requestJson', 'shutdown'].map(key => [key, StdioClient.prototype[key]]));
let delivered = [], launches = [], offline = false;
StdioClient.prototype.ensureStarted = function(binary, options) { launches.push({ binary, options }); };
StdioClient.prototype.request = async function(body) {
  return { Ok: { observed_ms: Date.now(), workspace_path: body.GetEditorContext.workspace_path, repositories: [] } };
};
StdioClient.prototype.requestJson = async function(parts) {
  if (offline) throw new Error('offline');
  const batch = JSON.parse(Buffer.concat(parts)).RecordEditorEvents;
  delivered.push(batch);
  return { Ok: { schema: 1, operation_schema: 3, ack: batch.events.map(event => [event.session, event.sequence]) } };
};
StdioClient.prototype.shutdown = async function() {};
test.after(() => Object.assign(StdioClient.prototype, original));

async function setup({ trusted = true, folders = 1, enabled = true, archive = false, remote = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-capture-host-'));
  delivered = []; launches = []; offline = false;
  f.context.subscriptions = [];
  f.context.storageUri = uri(`file://${root}/storage`);
  f.context.globalStorageUri = uri(`file://${root}/global`);
  f.api.env.remoteName = remote ? 'ssh-remote' : undefined;
  f.api.workspace.isTrusted = trusted;
  f.api.workspace.workspaceFolders = Array.from({ length: folders }, (_, index) => ({ name: `repo-${index}`, index,
    uri: uri(`${remote ? 'vscode-remote://ssh-remote+host' : 'file://'}${root}/repo-${index}`) }));
  f.configuration.clear();
  f.configuration.set(undefined, { 'tracking.enabled': enabled, 'native.capturePath': process.execPath,
    'tracking.jsonl.enabled': archive, 'tracking.jsonl.directory': path.join(root, 'archive') });
  let reads = 0;
  const docs = f.api.workspace.workspaceFolders.map(folder => ({ uri: uri(`${folder.uri.toString()}/a.ts`), version: 1,
    isUntitled: false, text: 'unsaved 😀', getText() { reads++; return this.text; }, offsetAt(position) { return position.character; } }));
  f.api.workspace.textDocuments = docs;
  const editor = { document: docs[0], visibleRanges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }] };
  f.api.window.activeTextEditor = editor;
  f.api.window.visibleTextEditors = [editor];
  f.api.window.tabGroups.all = [{ tabs: docs.map(document => ({ input: new f.api.TabInputText(document.uri) })) }];
  const host = extension.activate(f.context);
  await host.capture.snapshot();
  const edit = (text, document = docs[0]) => {
    const before = document.text;
    document.text = text; document.version++;
    f.events.change.fire({ document, contentChanges: [{ rangeOffset: 0, rangeLength: before.length, text }],
      detailedReason: { source: 'cursor', metadata: { kind: 'type' } } });
  };
  const cleanup = async () => {
    offline = false;
    await extension.deactivate();
    for (const disposable of f.context.subscriptions) disposable.dispose();
    await fs.rm(root, { recursive: true, force: true });
  };
  return { root, docs, host, edit, reads: () => reads, cleanup };
}

test('activation captures unsaved input before views open and after all views close, with exact raw archives', async () => {
  const s = await setup({ archive: true });
  try {
    assert.equal(await s.host.capture.flush(), true);
    const baseline = delivered.flatMap(batch => batch.events).find(event => event.event.type === 'document_snapshot');
    assert.equal(baseline.event.text, 'unsaved 😀');
    assert.deepEqual(baseline.units, { offsets: 'utf16_code_units', positions: 'zero_based_line_utf16_column', snapshots: 'utf8_bytes' });
    const panel = view();
    f.calls.providers.at(-1).provider.resolveWebviewView(panel);
    panel.dispose();
    s.edit('edited while every Idle view is closed');
    assert.equal(await s.host.capture.flush(), true);
    const changed = delivered.flatMap(batch => batch.events).find(event => event.event.type === 'document_changed');
    assert.equal(changed.event.before, 'unsaved 😀');
    assert.equal(changed.event.after, 'edited while every Idle view is closed');
    assert.ok(launches.every(call => call.options.cwd === f.api.workspace.workspaceFolders[0].uri.fsPath));
    await s.host.capture.shutdown();
    const [name] = await fs.readdir(path.join(s.root, 'archive'));
    const archive = (await fs.readFile(path.join(s.root, 'archive', name), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(archive.map(line => line.event), delivered.flatMap(batch => batch.events));
    assert.equal(archive.at(-1).event.event.type, 'tracking_stopped');
  } finally { await s.cleanup(); }
});

test('Workspace Trust gates buffer reads, local capture files and every native request', async () => {
  const s = await setup({ trusted: false, archive: true });
  try {
    s.edit('private unsaved input');
    assert.equal(s.reads(), 0);
    assert.deepEqual(launches, []);
    assert.deepEqual(await fs.readdir(s.root), []);
    f.api.workspace.isTrusted = true;
    f.events.trust.fire();
    assert.equal(await s.host.capture.flush(), true);
    assert.ok(delivered.flatMap(batch => batch.events).some(event => event.event.text === 'private unsaved input'));
    const reads = s.reads(), started = launches.length;
    f.api.workspace.isTrusted = false;
    s.edit('after trust was removed');
    assert.equal(s.reads(), reads, 'callbacks check current trust before getText');
    assert.equal(launches.length, started, 'no native request after trust was removed');
  } finally { f.api.workspace.isTrusted = true; await s.cleanup(); }
});

test('tracking pause and resume retain pending batches and establish a fresh unsaved baseline', async () => {
  const s = await setup();
  try {
    offline = true;
    s.edit('pending unsaved input');
    assert.equal(await s.host.capture.flush(), false);
    await f.commands.get('idle.tracking.stop')();
    const reads = s.reads();
    s.edit('input while paused');
    assert.equal(s.reads(), reads);
    assert.deepEqual(await s.host.capture.snapshot(), []);
    offline = false;
    await f.commands.get('idle.tracking.start')();
    assert.equal(await s.host.capture.flush(), true);
    const events = delivered.flatMap(batch => batch.events);
    assert.ok(events.some(event => event.event.after === 'pending unsaved input'));
    assert.ok(events.some(event => event.event.type === 'tracking_gap'));
    const resumed = events.findIndex(event => event.event.text === 'input while paused');
    const pending = events.findIndex(event => event.event.after === 'pending unsaved input');
    assert.ok(pending >= 0 && pending < resumed, 'recovered batches precede the resumed recorder');
  } finally { await s.cleanup(); }
});

test('folder settings isolate capture and multi-root windows do not assign untitled buffers to the first folder', async () => {
  const s = await setup({ folders: 2, enabled: false });
  try {
    const selected = f.api.workspace.workspaceFolders[1];
    f.configuration.set(selected.uri.toString(), { 'tracking.enabled': true, chainDirectory: 'selected-chain' });
    const untitled = { ...s.docs[0], uri: uri('untitled:/Unsaved-1'), isUntitled: true };
    f.api.workspace.textDocuments.push(untitled);
    await s.host.capture.restart();
    assert.equal(await s.host.capture.flush(), true);
    s.edit('ignored root', s.docs[0]); s.edit('selected root', s.docs[1]);
    s.edit('ambiguous untitled', untitled);
    assert.equal(await s.host.capture.flush(), true);
    assert.ok(delivered.every(batch => batch.workspace_path === selected.uri.fsPath && batch.chain_dir === path.join(selected.uri.fsPath, 'selected-chain')));
    const events = delivered.flatMap(batch => batch.events);
    assert.ok(events.some(event => event.event.after === 'selected root'));
    assert.ok(!events.some(event => event.event.after === 'ignored root' || event.event.after === 'ambiguous untitled'));
  } finally { await s.cleanup(); }
});

test('remote capture uses the file-owning host and rejects a different URI authority', async () => {
  const s = await setup({ remote: true });
  try {
    const foreign = { ...s.docs[0], uri: uri(s.docs[0].uri.toString().replace('ssh-remote+host', 'ssh-remote+other')) };
    f.events.open.fire(foreign);
    s.edit('remote unsaved input'); s.edit('foreign input', foreign);
    assert.equal(await s.host.capture.flush(), true);
    const events = delivered.flatMap(batch => batch.events);
    assert.ok(events.some(event => event.event.after === 'remote unsaved input'));
    assert.ok(!events.some(event => event.event.after === 'foreign input'));
  } finally { await s.cleanup(); }
});

test('an enabled parent root cannot bypass capture disabled in a nested workspace folder', async () => {
  const s = await setup({ folders: 2, enabled: false });
  const resolve = f.api.workspace.getWorkspaceFolder;
  try {
    const parent = f.api.workspace.workspaceFolders[0];
    const nested = { ...f.api.workspace.workspaceFolders[1], uri: uri(`${parent.uri.toString()}/nested`) };
    f.api.workspace.workspaceFolders[1] = nested;
    s.docs[1].uri = uri(`${nested.uri.toString()}/private.ts`);
    f.api.workspace.getWorkspaceFolder = resource => [...f.api.workspace.workspaceFolders]
      .sort((left, right) => right.uri.toString().length - left.uri.toString().length)
      .find(folder => resource.toString() === folder.uri.toString() || resource.toString().startsWith(folder.uri.toString() + '/'));
    f.configuration.set(parent.uri.toString(), { 'tracking.enabled': true });
    await s.host.capture.restart();
    s.edit('parent input', s.docs[0]); s.edit('nested private input', s.docs[1]);
    assert.equal(await s.host.capture.flush(), true);
    const events = delivered.flatMap(batch => batch.events);
    assert.ok(events.some(event => event.event.after === 'parent input'));
    assert.ok(!events.some(event => event.event.document?.uri === s.docs[1].uri.toString()));
  } finally { f.api.workspace.getWorkspaceFolder = resolve; await s.cleanup(); }
});
