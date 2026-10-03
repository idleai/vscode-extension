const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { fixture, uri, loadWithVSCode } = require('./helpers/vscode.cjs');
const { parsePreview } = require('../out/provenance/contracts');

const f = fixture();
const { ActivityDecorations } = loadWithVSCode('../../out/provenance', f.api);
const { HistoryHost } = loadWithVSCode('../../out/history', f.api);
const { HostEffects } = require('../out/host/effects');
const { documentUri, documentAddress } = loadWithVSCode('../../out/history/documents', f.api);
const binding = { workspace_id: 'workspace', repository_id: 'repo', chain: 'chain' };
const record = { operation: 'a'.repeat(64), hash: 'b'.repeat(64) };
const revision = { session: 'capture', document: 'buffer', version: 1 };
const source = { record, original: true };
const diagnostics = { command: (_, run) => run(), failure() {} };
const request = { binding, source: 'current', selection: { Editor: revision } };

function preview(request, values = {}) {
  return { request, record, revision: 'c'.repeat(64), text: 'a😀\r\nz', issues: [],
    indicators: [{ kind: 'human', range: { start: [0, 1], end: [0, 3] }, label: 'Human input recorded', sources: [source] },
      { kind: 'read', range: { start: [1, 0], end: [1, 1] }, label: 'Read interval recorded: 500 ms', sources: [source] }], ...values };
}

function editor(address = 'file:///one/a.rs') {
  const document = { uri: uri(address), version: 1, text: 'a😀\r\nz', getText() { return this.text; },
    lineAt(line) { return { range: { end: { line, character: this.text.split(/\r\n|\r|\n/)[line].length } } }; } };
  const decorations = new Map();
  return { document, decorations, setDecorations(type, values) { decorations.set(type, values); } };
}

function entries(editor) { return [...editor.decorations.values()].flat(); }
function header(editor) { return entries(editor).find(entry => entry.renderOptions)?.renderOptions.after.contentText; }
const settled = () => delay(160);

function harness(resolve = async request => preview(request)) {
  f.api.workspace.isTrusted = true;
  f.configuration.clear();
  f.api.window.visibleTextEditors = [];
  const calls = [];
  const changed = new f.api.EventEmitter();
  const captured = new f.api.EventEmitter();
  const history = { onDidChange: changed.event, async activity(request, signal, connection) {
    calls.push({ request, signal, connection }); return resolve(request, signal);
  } };
  const capture = { onDidChange: captured.event, revision: document => ({ ...revision, version: document.version }) };
  const assembly = { ensureBindingFor: resource => ({ ...binding, repository_id: resource.path.startsWith('/two/') ? 'repo-two' : binding.repository_id }) };
  const host = new ActivityDecorations(history, capture, assembly, diagnostics);
  const show = (...editors) => {
    f.api.window.visibleTextEditors = editors;
    f.api.window.activeTextEditor = editors[0];
    f.events.visibleEditors.fire(editors);
  };
  return { host, calls, changed, captured, capture, show };
}

test('native decorations map exact Unicode revisions in split editors and refresh after capture', async () => {
  const h = harness();
  const left = editor();
  const split = { ...editor(), document: left.document };
  try {
    h.show(left, split);
    await settled();
    assert.equal(h.calls.length, 1, 'split editors share one revision read');
    assert.deepEqual(h.calls[0].request.selection, { Editor: revision });
    for (const view of [left, split]) {
      assert.ok(entries(view).some(entry => JSON.stringify(entry.range.coordinates) === JSON.stringify([0, 1, 0, 3])));
      assert.match(header(view), /human.*read interval/);
    }
    h.captured.fire(uri('file:///one'));
    assert.equal(entries(left).length, 0, 'stale marks clear as soon as recorded history changes');
    await settled();
    assert.equal(h.calls.length, 2);
    assert.match(header(left), /human/);
  } finally { h.host.dispose(); }
  assert.equal(entries(left).length, 0, 'dispose removes painted ranges');
});

test('changed buffers reject delayed responses and do not borrow equal-content revisions', async () => {
  const pending = [];
  const h = harness(request => new Promise(resolve => pending.push({ request, resolve })));
  const view = editor();
  try {
    h.show(view);
    await settled();
    view.document.version++;
    f.events.changeDocument.fire({ document: view.document, contentChanges: [{}] });
    assert.equal(h.calls[0].signal.aborted, true);
    pending[0].resolve(preview(pending[0].request));
    await settled();
    assert.equal(header(view), undefined, 'identical bytes cannot revive the old version');
    assert.equal(pending[1].request.selection.Editor.version, 2);
    pending[1].resolve(preview(pending[1].request));
    await delay(0);
    assert.match(header(view), /human/);
    view.document.text = 'different';
    h.changed.fire();
    await settled();
    pending[2].resolve(preview(pending[2].request));
    await delay(0);
    assert.match(header(view), /unavailable/);
    assert.ok(entries(view).some(entry => entry.hoverMessage.value.includes('differs from')));
  } finally { h.host.dispose(); }
});

test('late conflicts, lost bindings, configuration and trust never leave stale indicators', async () => {
  let failure;
  const h = harness(async request => { if (failure) throw failure; return preview(request); });
  const view = editor();
  try {
    h.show(view);
    await settled();
    failure = Object.assign(new Error('conflict'), { code: 'conflicted' });
    h.changed.fire();
    assert.equal(entries(view).length, 0);
    await settled();
    assert.match(header(view), /unavailable/);
    f.configuration.set(view.document.uri.toString(), { 'decorations.enabled': false });
    f.events.configuration.fire({ affectsConfiguration: key => key === 'idle' });
    await settled();
    assert.equal(entries(view).length, 0, 'disabled decorations stay clear');
    f.configuration.clear();
    f.api.workspace.isTrusted = false;
    h.host.refresh();
    await settled();
    assert.equal(entries(view).length, 0, 'untrusted workspaces cannot read or render observations');
    f.api.workspace.isTrusted = true;
    failure = undefined;
    f.events.trust.fire();
    await settled();
    assert.match(header(view), /human/);
    h.show();
    await settled();
    assert.equal(entries(view).length, 0, 'hidden documents release their decorations and cached sources');
  } finally { f.api.workspace.isTrusted = true; h.host.dispose(); }
});

test('historical file and right diff previews retain source, binding and document generation', async () => {
  const h = harness();
  const action = { binding, source: 'retained', record, target: 'Diff' };
  const after = editor(documentUri({ connection: 'generation', request: action, part: 1 }, 'a.rs', 'text').toString());
  const before = editor(documentUri({ connection: 'generation', request: action, part: 0 }, 'a.rs', 'text').toString());
  try {
    h.show(after, before);
    await settled();
    assert.equal(h.calls.length, 1, 'the before side cannot inherit the resulting revision');
    assert.deepEqual(h.calls[0].request, { binding, source: 'retained', selection: { Record: record } });
    assert.equal(h.calls[0].connection, 'generation');
    assert.match(header(after), /human/);
    assert.match(header(before), /unavailable/);
  } finally { h.host.dispose(); }
});

test('source links use native history commands and recorded text cannot inject actions', async () => {
  const h = harness(async request => preview(request, { indicators: [{ kind: 'human', range: null,
    label: '[run](command:workbench.action.terminal.new)', sources: [source] }], issues: ['Exposure is unknown.'] }));
  const view = editor();
  const second = editor('file:///two/b.rs');
  const originalQuickPick = f.api.window.showQuickPick;
  try {
    h.show(view, second);
    await settled();
    const hover = entries(view).find(entry => entry.hoverMessage).hoverMessage;
    assert.match(hover.value, /\\\[run\\\]/, 'recorded labels are escaped');
    assert.deepEqual(hover.isTrusted.enabledCommands, ['idle.history.openRecord', 'idle.history.openOriginal', 'idle.activity.showSources']);
    const link = /command:idle\.history\.openOriginal\?([^)]*)/.exec(hover.value);
    assert.ok(link);
    assert.deepEqual(JSON.parse(decodeURIComponent(link[1])), [{ binding, source: 'current', record, target: 'Original' }]);
    f.api.window.activeTextEditor = second;
    f.api.window.showQuickPick = async choices => choices.find(choice => choice.request.target === 'Original');
    await f.commands.get('idle.activity.showSources')(view.document.uri.toString());
    assert.deepEqual(f.calls.editorCommands.at(-1), { id: 'idle.history.openOriginal', args: [{ binding, source: 'current', record, target: 'Original' }] }, 'hover sources stay attached to their editor in a multi-root window');
  } finally { f.api.window.showQuickPick = originalQuickPick; h.host.dispose(); }
});

test('history host cancels replaced bindings and refuses expired historical document generations', async () => {
  const effects = new HostEffects(() => true);
  const history = new HistoryHost('/extension', effects, diagnostics);
  const pending = [];
  const provider = {
    shutdown: async () => {}, activity: (request, signal) => new Promise(resolve => pending.push({ request, signal, resolve })),
    resolve: async request => ({ request, documents: [{ name: 'a.rs', record, field: 'FileAfter', reference: null, bytes: 'a😀\r\nz' }] }),
  };
  let lease = history.connect({ root: uri('file:///one'), repository: binding, chainDirectory: '/one/chain' }, provider);
  try {
    const opened = await history.open({ binding, source: 'current', record, target: 'File' });
    const address = documentAddress(uri(opened.uris[0]));
    const loading = history.activity(request, new AbortController().signal);
    lease.dispose();
    lease = history.connect({ root: uri('file:///one'), repository: binding, chainDirectory: '/one/other-chain' }, provider);
    assert.equal(pending[0].signal.aborted, true);
    pending[0].resolve(preview(request));
    await assert.rejects(loading, { code: 'cancelled' });
    await assert.rejects(history.activity({ ...request, selection: { Record: record } }, new AbortController().signal, address.connection), { code: 'unavailable' });
    await assert.rejects(history.activity({ ...request, source: 'retained' }, new AbortController().signal), { code: 'unavailable' });
  } finally { lease.dispose(); await history.shutdown(); effects.dispose(); }
});

test('native payload validation rejects unrelated snapshots and invalid UTF-16 geometry', () => {
  assert.equal(parsePreview(preview(request), request).text, 'a😀\r\nz');
  for (const changed of [
    { request: { ...request, binding: { ...binding, chain: 'other' } } },
    { indicators: [{ ...preview(request).indicators[0], range: { start: [0, 2], end: [0, 3] } }] },
    { indicators: [{ ...preview(request).indicators[0], range: { start: [2, 0], end: [3, 0] } }] },
    { indicators: [{ ...preview(request).indicators[0], sources: [{ record: { operation: 'abcd', hash: record.hash }, original: true }] }] },
    { text: 'binary\0content' },
  ]) assert.throws(() => parsePreview(preview(request, changed), request));
  const selected = { ...request, selection: { Record: record } };
  assert.throws(() => parsePreview(preview(selected, { record: { ...record, hash: 'd'.repeat(64) } }), selected));
});
