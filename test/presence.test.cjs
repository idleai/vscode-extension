const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: turn, setTimeout: delay } = require('node:timers/promises');
const { fixture, uri, loadWithVSCode } = require('./helpers/vscode.cjs');
const golden = require('./fixtures/peer-view.json');
const f = fixture();
const { PeerAwarenessHost } = loadWithVSCode('../../out/presence', f.api);
const { relativeFile } = loadWithVSCode('../../out/presence/editor', f.api);
const settle = async () => { await turn(); await turn(); };

function setup(t, mode = 'Standalone') {
  f.api.workspace.isTrusted = true;
  f.api.env.remoteName = undefined;
  f.api.extensions.getExtension = () => undefined;
  f.api.window.activeTextEditor = { document: { uri: uri('file:///one/src/lib.rs') } };
  f.api.window.showQuickPick = async () => undefined;
  const notifications = [];
  const failures = [];
  f.api.window.showInformationMessage = async (...args) => { notifications.push(args); };
  const diagnostics = {
    notify: async (kind, text) => { notifications.push([kind, text]); },
    failure: (operation, error) => failures.push({ operation, code: error.code }),
    command: async (_, action) => { try { return await action(); } catch (error) { failures.push({ code: error.code }); } },
  };
  const changed = new f.api.EventEmitter();
  const calls = { updates: [], joins: [] };
  const template = structuredClone(golden);
  template.editor.mode = mode;
  for (const offer of template.peers.flatMap(peer => peer.joins)) offer.request.mode = mode;
  const provider = {
    onDidChange: changed.event,
    update: async (editor, signal) => {
      calls.updates.push({ editor, signal });
      return { ...structuredClone(template), editor };
    },
    join: async (request, signal) => { calls.joins.push({ request, signal }); return 'connected'; },
  };
  const host = new PeerAwarenessHost(diagnostics);
  t.after(() => { host.dispose(); changed.dispose(); });
  const { file, branch, ...context } = template.editor;
  const binding = { root: uri('file:///one'), context };
  return { host, binding, provider, calls, template, changed, failures, notifications };
}

for (const mode of ['Standalone', 'Managed']) {
  test(`${mode} renders Rust-supplied user, branch, host and summary, then routes each grant separately`, async t => {
    const s = setup(t, mode);
    s.host.connect(s.binding, s.provider);
    await settle();
    const lenses = s.host.provideCodeLenses(f.api.window.activeTextEditor.document);
    assert.equal(lenses.length, 1);
    assert.equal(lenses[0].command.title, 'Alice · branch: feature · host: Build host · Fixing parser edge cases.');
    assert.equal(lenses[0].command.command, 'idle.presence.showPeers');
    assert.deepEqual(lenses[0].command.arguments, ['alice-connection']);
    assert.deepEqual(s.host.provideCodeLenses({ uri: uri('file:///two/src/lib.rs') }), []);
    assert.deepEqual(s.host.provideCodeLenses({ uri: uri('file:///one/other.rs') }), []);
    assert.equal(s.calls.updates[0].editor.file, 'src/lib.rs');
    assert.equal(s.calls.updates[0].editor.branch, null);
    assert.equal(s.calls.updates[0].editor.contributor_id, 'me');
    for (const kind of ['session', 'host']) {
      f.api.window.showQuickPick = async choices => choices.find(choice => choice.offer.request.target.kind === kind);
      await s.host.showPeers('alice-connection');
      const request = s.calls.joins.at(-1).request;
      assert.equal(request.mode, mode);
      assert.equal(request.contributor_id, 'me');
      assert.equal(request.grant_id, `${kind}-grant`);
      assert.deepEqual(request.binding, golden.editor.binding);
    }
    assert.equal(s.calls.joins.length, 2);
    assert.deepEqual(s.failures, []);
  });
}

test('missing reports stay unknown and provider text cannot inject commands or codicons', async t => {
  const s = setup(t);
  const peer = s.template.peers[0];
  peer.host = null;
  peer.branch = null;
  peer.summary = '[click](command:bad)\n$(zap)';
  peer.joins = [];
  s.host.connect(s.binding, s.provider);
  await settle();
  const lens = s.host.provideCodeLenses(f.api.window.activeTextEditor.document)[0];
  assert.match(lens.command.title, /unknown branch · host: unknown host/);
  assert.match(lens.command.title, /\[click\]\(command:bad\) ＄\(zap\)/);
  assert.equal(lens.command.command, 'idle.presence.showPeers');
  f.api.window.showQuickPick = async choices => {
    assert.equal(choices[0].description, 'No join invitation is currently available');
    return choices[0];
  };
  await s.host.showPeers();
  assert.deepEqual(s.calls.joins, []);
});

test('unconfigured awareness is explicit and never authenticates or connects by itself', async t => {
  const s = setup(t);
  await s.host.showPeers();
  assert.match(s.notifications.at(-1)[1], /unavailable/);
  assert.deepEqual(s.calls.updates, []);
  assert.deepEqual(s.calls.joins, []);
  assert.equal(f.calls.auth.length, 0);
});

test('a stale picker cannot join after grant revocation, account change or workspace replacement', async t => {
  const s = setup(t);
  s.host.connect(s.binding, s.provider);
  await settle();
  let choose;
  f.api.window.showQuickPick = choices => new Promise(resolve => { choose = () => resolve(choices[0]); });
  const pending = s.host.showPeers();
  s.template.peers[0].joins = [];
  s.changed.fire();
  await settle();
  choose();
  await assert.rejects(pending, error => error.code === 'stale_invitation');
  assert.deepEqual(s.calls.joins, []);
  const registration = s.host.connect(s.binding, s.provider);
  const replacement = s.host.connect({ ...s.binding, context: { ...s.binding.context, mode: 'Managed' } }, s.provider);
  registration.dispose();
  await settle();
  assert.equal(s.calls.updates.at(-1).signal.aborted, false, 'retiring an old binding does not disconnect its replacement');
  replacement.dispose();
  assert.equal(s.calls.updates.at(-1).signal.aborted, true);
});

test('single-flight updates discard late editor/context responses and continue with the newest observation', async t => {
  const s = setup(t);
  const pending = [];
  s.provider.update = (editor, signal) => new Promise(resolve => pending.push({ editor, signal, resolve }));
  s.host.connect(s.binding, s.provider);
  f.api.window.activeTextEditor = { document: { uri: uri('file:///one/other.rs') } };
  f.events.activeEditor.fire();
  assert.equal(pending.length, 1, 'provider updates are serialized');
  pending[0].resolve({ ...s.template, editor: pending[0].editor });
  await settle();
  assert.equal(pending.length, 2);
  assert.equal(pending[1].editor.file, 'other.rs');
  assert.deepEqual(s.host.provideCodeLenses(f.api.window.activeTextEditor.document), []);
  const binding = { ...s.binding, context: { ...s.binding.context, contributor_id: 'new-user' } };
  s.host.connect(binding, s.provider);
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve({ ...s.template, editor: pending[1].editor });
  await settle();
  assert.deepEqual(s.host.provideCodeLenses(f.api.window.activeTextEditor.document), []);
  assert.equal(pending.at(-1).editor.contributor_id, 'new-user');
});

test('a mixed-context invitation never reaches either provider even when its outer view matches', async t => {
  const s = setup(t);
  const request = s.template.peers[0].joins[0].request;
  request.binding.workspace_id = 'another-workspace';
  request.contributor_id = 'another-user';
  request.mode = 'Managed';
  s.host.connect(s.binding, s.provider);
  await settle();
  f.api.window.showQuickPick = async choices => choices[0];
  await assert.rejects(s.host.showPeers(), error => error.code === 'invalid_invitation');
  assert.deepEqual(s.calls.joins, []);
});

test('trust, root binding, and provider failures clear UI and prevent joins', async t => {
  const s = setup(t);
  f.api.workspace.isTrusted = false;
  assert.throws(() => s.host.connect(s.binding, s.provider), error => error.code === 'workspace_untrusted');
  f.api.workspace.isTrusted = true;
  assert.throws(() => s.host.connect({ ...s.binding, root: uri('file:///outside') }, s.provider), error => error.code === 'folder_unavailable');
  s.host.connect(s.binding, s.provider);
  await settle();
  assert.equal(s.host.provideCodeLenses(f.api.window.activeTextEditor.document).length, 1);
  s.provider.update = async () => { throw new Error('private-provider-detail'); };
  s.changed.fire();
  await settle();
  assert.deepEqual(s.host.provideCodeLenses(f.api.window.activeTextEditor.document), []);
  assert.equal(s.failures.length, 1);
  assert.equal(JSON.stringify(s.notifications).includes('private-provider-detail'), false);
  f.api.workspace.isTrusted = false;
  s.changed.fire();
  assert.equal(s.calls.updates[0].signal.aborted, true);
});

test('expired presence is cleared while refreshing, and slow responses cannot extend its lifetime', async t => {
  const s = setup(t);
  s.template.valid_for_ms = 30;
  const original = s.provider.update;
  let updates = 0;
  s.provider.update = async (...args) => {
    if (++updates > 1) return new Promise(() => {});
    return original(...args);
  };
  s.host.connect(s.binding, s.provider);
  await settle();
  assert.equal(s.host.provideCodeLenses(f.api.window.activeTextEditor.document).length, 1);
  await delay(50);
  assert.equal(updates, 2);
  assert.deepEqual(s.host.provideCodeLenses(f.api.window.activeTextEditor.document), []);
  s.provider.update = async editor => { await delay(40); return { ...s.template, editor }; };
  s.host.connect(s.binding, s.provider);
  await delay(60);
  assert.deepEqual(s.host.provideCodeLenses(f.api.window.activeTextEditor.document), []);
  assert.equal(s.failures.at(-1).code, 'stale_presence');
});

test('Git observations track only the explicitly bound checkout, including detached HEAD and removal', async t => {
  const s = setup(t);
  const stateChanged = new f.api.EventEmitter();
  const opened = new f.api.EventEmitter();
  const closed = new f.api.EventEmitter();
  const apiChanged = new f.api.EventEmitter();
  const enablement = new f.api.EventEmitter();
  const repository = { rootUri: uri('file:///one'), state: { HEAD: { name: 'main' }, onDidChange: stateChanged.event } };
  const git = {
    state: 'initialized', repositories: [{ ...repository, rootUri: uri('file:///two') }, repository],
    onDidOpenRepository: opened.event, onDidCloseRepository: closed.event, onDidChangeState: apiChanged.event,
  };
  const exports = { enabled: true, getAPI: version => { assert.equal(version, 1); return git; }, onDidChangeEnablement: enablement.event };
  f.api.extensions.getExtension = name => { assert.equal(name, 'vscode.git'); return { activate: async () => exports }; };
  s.host.connect(s.binding, s.provider);
  await settle();
  assert.equal(s.calls.updates.at(-1).editor.branch, 'main');
  const observed = s.calls.updates.length;
  stateChanged.fire();
  await settle();
  assert.equal(s.calls.updates.length, observed, 'ordinary Git status updates do not republish unchanged presence or cancel joins');
  repository.state.HEAD.name = 'feature';
  stateChanged.fire();
  await settle();
  assert.equal(s.calls.updates.at(-1).editor.branch, 'feature');
  repository.state.HEAD = { commit: 'abc' };
  stateChanged.fire();
  await settle();
  assert.equal(s.calls.updates.at(-1).editor.branch, null);
  git.repositories.pop();
  closed.fire(repository);
  await settle();
  assert.equal(stateChanged.listeners.size, 0);
  f.api.window.activeTextEditor = { document: { uri: uri('file:///two/src/lib.rs') } };
  f.events.activeEditor.fire();
  await settle();
  assert.equal(s.calls.updates.at(-1).editor.file, null);
  assert.equal(s.calls.updates.at(-1).editor.branch, null);
  s.host.dispose();
  assert.equal(enablement.listeners.size, 0);
  assert.equal(opened.listeners.size, 0);
});

test('branch invitations require an explicit click and distinguish pending from connected results', async t => {
  const s = setup(t);
  s.template.invitations = [{ change: 'peer', peer: structuredClone(s.template.peers[0]) }];
  s.template.invitations[0].peer.branch = 'main';
  f.api.window.showInformationMessage = async (message, action) => { s.notifications.push([message, action]); return action; };
  f.api.window.showQuickPick = async choices => choices[0];
  s.provider.join = async (request, signal) => { s.calls.joins.push({ request, signal }); return 'pending'; };
  s.host.connect(s.binding, s.provider);
  await settle();
  assert.match(s.notifications[0][0], /Alice switched to your branch/);
  assert.equal(s.calls.joins.length, 1);
  assert.match(s.notifications.at(-1)[1], /waiting for the runtime connection/);
  assert.equal(s.notifications.flat().some(value => value?.startsWith('Joined')), false);
});

test('in-flight joins are deduplicated and cancelled on invalidation or shutdown', async t => {
  const s = setup(t);
  s.host.connect(s.binding, s.provider);
  await settle();
  let resolve;
  s.provider.join = (request, signal) => new Promise(done => { s.calls.joins.push({ request, signal }); resolve = done; });
  f.api.window.showQuickPick = async choices => choices[0];
  const first = s.host.showPeers();
  await turn();
  await s.host.showPeers();
  assert.equal(s.calls.joins.length, 1);
  s.changed.fire();
  assert.equal(s.calls.joins[0].signal.aborted, true);
  resolve('connected');
  await first;
  assert.deepEqual(s.notifications, [], 'late connection success is not reported in a new view');
  s.host.dispose();
  assert.equal(s.calls.updates.at(-1).signal.aborted, true);
});

test('relative editor paths respect host authority, nested roots and virtual documents', () => {
  const root = uri('vscode-remote://ssh-remote+host/home/repo');
  assert.equal(relativeFile(root, uri('vscode-remote://ssh-remote+host/home/repo/src/file.rs')), 'src/file.rs');
  for (const file of [
    'vscode-remote://ssh-remote+other/home/repo/src/file.rs', 'file:///home/repo/src/file.rs',
    'git:///home/repo/src/file.rs', 'vscode-remote://ssh-remote+host/home/repository/src/file.rs',
    'vscode-remote://ssh-remote+host/home/repo/src/file.rs?ref=old',
  ]) assert.equal(relativeFile(root, uri(file)), null);
  assert.equal(relativeFile(uri('file:///one/nested'), uri('file:///one/src/lib.rs')), null);
});
