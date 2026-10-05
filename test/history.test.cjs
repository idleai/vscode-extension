const { NativeHost } = require('../out/host/nativeHost');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { getEventListeners } = require('node:events');
const { setImmediate: turn } = require('node:timers/promises');
const { fixture, uri, loadWithVSCode } = require('./helpers/vscode.cjs');

const f = fixture();
const { HistoryHost, HistoryFailure } = loadWithVSCode(path.resolve(__dirname, '../out/history'), f.api);
const { documentUri, documentAddress, hexText } = require('../out/history/documents');
const { HostEffects } = require('../out/host/effects');
const { WebviewBridge } = require('../out/host/messageBridge');
const repository = { workspace_id: 'workspace', repository_id: 'repository', chain: 'chain' };
const reference = { operation: '1'.repeat(64), hash: '2'.repeat(64) };
const request = target => ({ binding: repository, source: 'current', record: reference, target });
const binding = (root = uri('file:///one')) => ({ root, repository, chainDirectory: '/history/chain' });
const document = bytes => ({ name: 'src/file.ts', record: reference, field: 'FileAfter', reference: null, bytes });

function setup(t, bytes = 'recorded\r\n') {
  for (const values of Object.values(f.calls)) values.length = 0;
  f.configuration.clear();
  f.api.workspace.isTrusted = true;
  f.api.workspace.workspaceFolders = ['/one', '/two'].map(name => ({ name, uri: uri(`file://${name}`) }));
  f.api.env.remoteName = undefined;
  const effects = new HostEffects(() => f.api.workspace.isTrusted);
  const host = new HistoryHost(new NativeHost(() => '/unused/idle-host'), effects, { command: (_, action) => action(), failure() {} });
  const requests = [];
  const provider = {
    closed: 0,
    async resolve(selected, signal) {
      requests.push({ selected, signal });
      return { request: structuredClone(selected), documents: selected.target === 'Diff' ? [document('before\r\n'), document(bytes)] : [document(bytes)] };
    },
    async shutdown() { this.closed++; },
  };
  t.after(() => host.shutdown());
  return { host, provider, requests, effects, byteProvider: f.calls.fileProviders.at(-1).provider, hexProvider: f.calls.contentProviders.at(-1).provider };
}

test('native providers preserve BOM, Unicode, mixed endings, trailing spaces and empty files', async t => {
  const bytes = '\ufeff😀 first\r\nnext\nlast  ';
  const h = setup(t, bytes);
  h.host.connect(binding(), h.provider);
  const opened = await h.host.open(request('File'));
  assert.equal(f.calls.editorCommands[0].id, 'vscode.open');
  assert.equal(f.calls.fileProviders[0].options.isReadonly, true);
  assert.deepEqual(await h.byteProvider.readFile(uri(opened.byteUris[0])), Buffer.from(bytes));
  assert.match(opened.uris[0], /^idle-history-text:/);
  const textProvider = f.calls.contentProviders.find(value => value.scheme === 'idle-history-text').provider;
  f.configuration.set('file:///one', { 'files.encoding': 'utf16le' });
  assert.deepEqual(Buffer.from(await textProvider.provideTextDocumentContent(uri(opened.uris[0])), 'utf8'), Buffer.from(bytes));
  assert.equal((await h.byteProvider.stat(uri(opened.byteUris[0]))).size, Buffer.byteLength(bytes));
  h.provider.resolve = async selected => ({ request: selected, documents: [document('')] });
  const empty = await h.host.open(request('File'));
  assert.equal((await h.byteProvider.readFile(uri(empty.byteUris[0]))).length, 0);
});

test('binary raw records use a complete hex preview and retain their exact byte document', async t => {
  const bytes = [0, 255, 128, 13, 10, 239, 187, 191, ...Array.from({ length: 32 }, (_, index) => index)];
  const h = setup(t, bytes);
  h.host.connect(binding(), h.provider);
  const opened = await h.host.open(request('Record'));
  assert.match(opened.uris[0], /^idle-history-hex:/);
  assert.deepEqual(await h.byteProvider.readFile(uri(opened.byteUris[0])), Buffer.from(bytes));
  const text = await h.hexProvider.provideTextDocumentContent(uri(opened.uris[0]));
  const restored = text.split('\n').flatMap(line => line.split('  ')[1].split(' ').map(byte => parseInt(byte, 16)));
  assert.deepEqual(restored, bytes);
  const textProvider = f.calls.contentProviders.find(value => value.scheme === 'idle-history-text').provider;
  await assert.rejects(textProvider.provideTextDocumentContent(uri(opened.byteUris[0])), { code: 'binary_content' });
  assert.equal(hexText(Buffer.alloc(0)), '');
});

test('diffs open both complete recorded sides and share binary representation', async t => {
  const h = setup(t, [255, 0, 1]);
  h.host.connect(binding(), h.provider);
  const opened = await h.host.open(request('Diff'));
  assert.equal(f.calls.editorCommands.at(-1).id, 'vscode.diff');
  assert.equal(opened.uris.every(value => value.startsWith('idle-history-hex:')), true);
  assert.deepEqual(await h.byteProvider.readFile(uri(opened.byteUris[0])), Buffer.from('before\r\n'));
  assert.deepEqual(await h.byteProvider.readFile(uri(opened.byteUris[1])), Buffer.from([255, 0, 1]));
});

test('missing, unrecorded, corrupt and conflicted content never open a blank preview', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  for (const code of ['missing_content', 'not_recorded', 'corrupt_content', 'conflicted', 'missing_record', 'unresolvable_content']) {
    h.provider.resolve = async () => { throw new HistoryFailure(code, code); };
    await assert.rejects(h.host.open(request('Diff')), { code });
  }
  assert.deepEqual(f.calls.editorCommands, []);
});

test('aliases retain candidates and require a separate retained-source binding', async t => {
  const h = setup(t);
  const migrated = { operation: '3'.repeat(64), hash: '4'.repeat(64) };
  h.host.connect(binding(), h.provider);
  h.provider.resolve = async () => { throw new HistoryFailure('migrated_alias', 'Select a converted record.', [migrated]); };
  await assert.rejects(h.host.open(request('Record')), error => error.code === 'migrated_alias' && error.candidates[0].hash === migrated.hash);
  await assert.rejects(h.host.open({ ...request('Record'), source: 'retained' }), { code: 'unavailable' });
  const retained = { async resolve(selected) { return { request: selected, documents: [document('retained\r\n')] }; }, async shutdown() {} };
  h.host.connect({ ...binding(), retainedDirectory: '/history/retained-inputs' }, retained);
  const opened = await h.host.open({ ...request('Record'), source: 'retained' });
  assert.equal(documentAddress(uri(opened.byteUris[0])).request.source, 'retained');
  assert.deepEqual(await h.byteProvider.readFile(uri(opened.byteUris[0])), Buffer.from('retained\r\n'));
});

test('the webview receives complete migration and conflict candidates without private exception fields', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  const candidates = [{ operation: '3'.repeat(64), hash: '4'.repeat(64) }, { operation: '5'.repeat(64), hash: '6'.repeat(64) }];
  const replies = [];
  const bridge = new WebviewBridge('history-view', h.effects, async value => { replies.push(JSON.parse(JSON.stringify(value))); return true; }, () => {});
  t.after(() => bridge.dispose());
  const send = (method, params) => bridge.receive({ protocol: 1, session: 'history-view', id: 'open', method, params });
  for (const code of ['migrated_alias', 'record_mismatch', 'conflicted']) {
    const inputs = candidates.map(candidate => ({ ...candidate, privatePayload: 'DO-NOT-FORWARD' }));
    const failure = new HistoryFailure(code, 'Select an exact record.', inputs);
    failure.privatePayload = 'DO-NOT-FORWARD';
    inputs[0].hash = '7'.repeat(64);
    h.provider.resolve = async () => { throw failure; };
    for (const method of ['history.open', 'history.openQuery']) {
      const params = method === 'history.open' ? request('Record') : {
        binding: repository, query: { chain: repository.chain, action: { Open: { record: reference, target: 'Record' } } },
      };
      await send(method, params);
      assert.deepEqual(replies.pop().error, { code, message: 'Select an exact record.', details: { candidates } });
    }
  }
  assert.equal(f.calls.editorCommands.length, 0);
  h.provider.resolve = async selected => ({ request: selected, documents: [{ ...document('converted'), record: selected.record }] });
  await send('history.open', { ...request('Record'), record: candidates[0] });
  assert.equal(replies.pop().result.uris.length, 1);
  h.provider.resolve = async () => { throw Object.assign(new Error('DO-NOT-FORWARD'), { code: 'migrated_alias', details: { candidates } }); };
  await send('history.open', request('Record'));
  const error = replies.pop().error;
  assert.equal(error.code, 'host_failure');
  assert.equal('details' in error, false);
  assert.equal(JSON.stringify(error).includes('DO-NOT-FORWARD'), false);
});

test('full references and an exact workspace/repository/chain binding are mandatory', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  for (const record of [{ ...reference, operation: '1111' }, { ...reference, hash: '2222' }, { ...reference, hash: 'A'.repeat(64) }]) {
    await assert.rejects(h.host.open({ ...request('File'), record }), { code: 'invalid_reference' });
  }
  for (const key of ['workspace_id', 'repository_id', 'chain']) {
    await assert.rejects(h.host.open({ ...request('File'), binding: { ...repository, [key]: 'other' } }), { code: 'unavailable' });
  }
  assert.equal(h.requests.length, 0);
  assert.throws(() => h.host.connect({ ...binding(), chainDirectory: 'relative' }, h.provider), { code: 'invalid_binding' });
});

test('multi-root actions use the installed repository binding without first-folder fallback', async t => {
  const h = setup(t);
  const secondRepository = { ...repository, repository_id: 'second' };
  const seen = [];
  h.host.connect(binding(), h.provider);
  h.host.connect({ ...binding(uri('file:///two')), repository: secondRepository }, {
    async resolve(selected) { seen.push(selected); return { request: selected, documents: [document('second checkout')] }; }, async shutdown() {},
  });
  const opened = await h.host.open({ ...request('File'), binding: secondRepository });
  assert.equal(h.requests.length, 0);
  assert.equal(seen[0].binding.repository_id, 'second');
  assert.deepEqual(await h.byteProvider.readFile(uri(opened.byteUris[0])), Buffer.from('second checkout'));
});

test('replacing a binding cancels pending results and invalidates old documents', async t => {
  const h = setup(t);
  const lease = h.host.connect(binding(), h.provider);
  const opened = await h.host.open(request('File'));
  let resolve;
  let signal;
  h.provider.resolve = (selected, abort) => { signal = abort; return new Promise(done => { resolve = () => done({ request: selected, documents: [document('late')] }); }); };
  const pending = h.host.open(request('File'));
  const newProvider = { async resolve(selected) { return { request: selected, documents: [document('new')] }; }, async shutdown() {} };
  h.host.connect(binding(), newProvider);
  assert.equal(signal.aborted, true);
  resolve();
  await assert.rejects(pending, { code: 'cancelled' });
  await assert.rejects(h.byteProvider.readFile(uri(opened.byteUris[0])), { code: 'unavailable' });
  lease.dispose();
  const current = await h.host.open(request('File'));
  assert.deepEqual(await h.byteProvider.readFile(uri(current.byteUris[0])), Buffer.from('new'));
  assert.equal(h.provider.closed, 1);
});

test('closing a view aborts its action while keeping the installed history connection', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  const abort = new AbortController();
  const originalResolve = h.provider.resolve;
  h.provider.resolve = async (selected, signal) => { abort.abort(); return originalResolve(selected, signal); };
  await assert.rejects(h.effects.execute('history.open', request('File'), { signal: abort.signal, session: 'view' }), { code: 'cancelled' });
  assert.equal(h.provider.closed, 0);
  h.provider.resolve = originalResolve;
  await h.host.open(request('File'));
  assert.equal(f.calls.editorCommands.length, 1);
});

test('history effects work without AbortSignal.any and remove view listeners after success or failure', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor); else delete AbortSignal.any; });
  const abort = new AbortController();
  const context = { signal: abort.signal, session: 'view' };
  await h.effects.execute('history.open', request('File'), context);
  assert.equal(h.requests.length, 1);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  h.provider.resolve = async () => { throw new HistoryFailure('missing_content', 'Not received.'); };
  await assert.rejects(h.effects.execute('history.open', request('File'), context), { code: 'missing_content' });
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  h.provider.resolve = (_, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Native request aborted.')), { once: true });
    abort.abort();
  });
  await assert.rejects(h.effects.execute('history.open', request('File'), context), { code: 'cancelled' });
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.equal(f.calls.editorCommands.length, 1);
});

test('restart cancels pending reads, waits for native reset and preserves the binding lease', async t => {
  const h = setup(t);
  const lease = h.host.connect(binding(), h.provider);
  const opened = await h.host.open(request('File'));
  const resolve = h.provider.resolve;
  let pendingSignal;
  h.provider.resolve = (_, signal) => {
    pendingSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Native request aborted.')), { once: true }));
  };
  const pending = assert.rejects(h.host.open(request('File')), { code: 'cancelled' });
  let finish;
  h.provider.restart = () => new Promise(done => { finish = done; });
  const restart = h.host.restart();
  assert.equal(pendingSignal.aborted, true);
  await pending;
  await assert.rejects(h.byteProvider.readFile(uri(opened.byteUris[0])), { code: 'unavailable' });
  h.provider.resolve = resolve;
  const current = h.host.open(request('File'));
  await turn();
  assert.equal(h.requests.length, 1);
  finish();
  await restart;
  const next = await current;
  assert.notEqual(next.byteUris[0], opened.byteUris[0]);
  assert.deepEqual(await h.byteProvider.readFile(uri(next.byteUris[0])), Buffer.from('recorded\r\n'));
  assert.equal(h.provider.closed, 0);
  lease.dispose();
  assert.equal(h.provider.closed, 1);
  await assert.rejects(h.host.open(request('File')), { code: 'unavailable' });
});

test('restart keeps injected readers usable when they have no owned process to reset', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  await h.host.restart();
  await h.host.open(request('File'));
  assert.equal(h.provider.closed, 0);
  assert.equal(h.requests.length, 1);
});

test('a failed native reset can be retried without selecting the repository again', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  h.provider.restart = async () => { throw new Error('reset failed'); };
  await assert.rejects(h.host.restart(), /reset failed/);
  await assert.rejects(h.host.open(request('File')), /reset failed/);
  assert.equal(h.requests.length, 0);
  h.provider.restart = async () => {};
  await h.host.restart();
  await h.host.open(request('File'));
  assert.equal(h.requests.length, 1);
});

test('a restart finishing after replacement cannot restore the old binding or release its successor', async t => {
  const h = setup(t);
  const lease = h.host.connect(binding(), h.provider);
  let finish;
  h.provider.restart = () => new Promise(done => { finish = done; });
  const restart = assert.rejects(h.host.restart(), { code: 'cancelled' });
  await turn();
  const replacement = { async resolve(selected) { return { request: selected, documents: [document('new binding')] }; }, async shutdown() {} };
  h.host.connect(binding(), replacement);
  finish();
  await restart;
  lease.dispose();
  const opened = await h.host.open(request('File'));
  assert.deepEqual(await h.byteProvider.readFile(uri(opened.byteUris[0])), Buffer.from('new binding'));
});

test('trust and folder membership are rechecked after asynchronous resolution', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  h.provider.resolve = async selected => { f.api.workspace.isTrusted = false; return { request: selected, documents: [document('private')] }; };
  await assert.rejects(h.host.open(request('File')), { code: 'workspace_untrusted' });
  f.api.workspace.isTrusted = true;
  h.provider.resolve = async selected => { f.api.workspace.workspaceFolders = []; return { request: selected, documents: [document('private')] }; };
  await assert.rejects(h.host.open(request('File')), { code: 'folder_unavailable' });
  assert.equal(f.calls.editorCommands.length, 0);
});

test('remote bindings retain their host scheme and virtual filesystems are rejected', async t => {
  const h = setup(t);
  const remote = uri('vscode-remote://ssh-remote+host/repository');
  f.api.workspace.workspaceFolders = [{ name: 'remote', uri: remote }, { name: 'virtual', uri: uri('memfs:///repo') }];
  assert.throws(() => h.host.connect(binding(remote), h.provider), { code: 'unsupported_filesystem' });
  f.api.env.remoteName = 'ssh-remote';
  h.host.connect(binding(remote), h.provider);
  await h.host.open(request('File'));
  assert.throws(() => h.host.connect(binding(uri('memfs:///repo')), h.provider), { code: 'unsupported_filesystem' });
});

test('malformed and foreign results cannot reach the native editor', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  const invalid = [
    selected => ({ request: { ...selected, source: 'retained' }, documents: [document('x')] }),
    selected => ({ request: selected, documents: [] }),
    selected => ({ request: selected, documents: [{ ...document('x'), record: { ...reference, hash: '3'.repeat(64) } }] }),
    selected => ({ request: selected, documents: [document([256])] }),
    selected => ({ request: selected, documents: [document('\ud800')] }),
    selected => ({ request: selected, documents: [document(null)] }),
    selected => ({ request: selected, documents: [null] }),
  ];
  for (const result of invalid) {
    h.provider.resolve = async selected => result(selected);
    await assert.rejects(h.host.open(request('File')), { code: 'invalid_response' });
  }
  assert.equal(f.calls.editorCommands.length, 0);
});

test('document names cannot select a filesystem location and all mutations are denied', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  h.provider.resolve = async selected => ({ request: selected, documents: [{ ...document('recorded'), name: '../../private\\other.ts' }] });
  const opened = await h.host.open(request('File'));
  assert.equal(uri(opened.byteUris[0]).path, '/other.ts');
  for (const action of ['writeFile', 'delete', 'rename', 'createDirectory']) assert.throws(() => h.byteProvider[action](), { code: 'NoPermissions' });
  assert.throws(() => h.byteProvider.readFile(uri('idle-history:/unknown')), { code: 'invalid_reference' });
  const missingSide = documentUri({ ...documentAddress(uri(opened.byteUris[0])), part: 1 }, 'other.ts');
  await assert.rejects(h.byteProvider.readFile(missingSide), { code: 'invalid_reference' });
});

test('app-core Open effects return Opened only after the native action succeeds', async t => {
  const h = setup(t);
  h.host.connect(binding(), h.provider);
  const params = { binding: repository, query: { chain: repository.chain, action: { Open: { record: reference, target: 'File' } } } };
  assert.equal(await h.host.openQuery(params), 'Opened');
  assert.equal(f.calls.editorCommands.at(-1).id, 'vscode.open');
  await assert.rejects(h.host.openQuery({ ...params, query: { ...params.query, chain: 'other' } }), { code: 'binding_mismatch' });
  await assert.rejects(h.host.openQuery({ ...params, query: { chain: repository.chain, action: { Open: { record: reference, target: 'File', binding: { ...repository, repository_id: 'other' } } } } }), { code: 'invalid_request' });
});

test('working files resolve within the explicit checkout, reject symlink escapes, and convert scalar positions', async t => {
  const h = setup(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-history-path-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'repo'));
  await fs.writeFile(path.join(directory, 'outside.ts'), 'outside');
  await fs.writeFile(path.join(directory, 'repo', 'file.ts'), 'a😀b\n');
  await fs.symlink(path.join(directory, 'outside.ts'), path.join(directory, 'repo', 'escape.ts'));
  const root = uri(pathToFileURL(path.join(directory, 'repo')).toString());
  f.api.workspace.workspaceFolders = [{ name: 'repo', uri: root }];
  h.host.connect(binding(root), h.provider);
  const opened = [];
  f.api.workspace.openTextDocument = async target => ({ uri: target, lineCount: 1, lineAt: () => ({ text: 'a😀b' }) });
  f.api.window.showTextDocument = async (document, options) => { opened.push({ document, options }); };
  const params = { binding: repository, path: 'file.ts', position: { line: 1, column: 3 } };
  await h.host.openWorking(params);
  assert.equal(opened[0].document.uri.toString(), `${root.toString()}/file.ts`);
  assert.deepEqual(opened[0].options.selection.coordinates, [0, 3, 0, 3]);
  for (const bad of ['../outside.ts', '/outside.ts', 'C:/outside.ts', 'a\\b', 'a/../b']) {
    await assert.rejects(h.host.openWorking({ ...params, path: bad }), { code: 'invalid_request' });
  }
  await assert.rejects(h.host.openWorking({ ...params, path: 'escape.ts' }), { code: 'denied' });
  await assert.rejects(h.host.openWorking({ ...params, revision: reference.operation }), { code: 'invalid_request' });
  assert.equal(opened.length, 1);
  assert.equal(h.requests.length, 0);
});
