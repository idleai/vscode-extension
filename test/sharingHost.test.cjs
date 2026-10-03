const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { fixture, loadWithVSCode } = require('./helpers/vscode.cjs');
const { HostError } = require('../out/host/protocol');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Sharing transition did not finish.');
}

function setup(prepare = () => {}) {
  const f = fixture(), managers = [], errors = [], notices = [], log = [], secrets = new Map();
  let selected = 0, accountCalls = 0, tunnelCalls = 0;
  const configuration = {
    assertTrusted() { if (!f.api.workspace.isTrusted) throw new HostError('workspace_untrusted', 'Trust is required.'); },
    forResource(uri) {
      this.assertTrusted();
      const folder = f.api.workspace.workspaceFolders.find(folder => folder.uri.toString() === uri.toString());
      if (!folder) throw new HostError('workspace_unavailable', 'Folder was removed.');
      return { folder, chainDirectory: path.join(folder.uri.fsPath, f.configuration.get(uri.toString())?.chainDirectory ?? '.editchain') };
    },
    peerBinary() { return '/peer'; },
  };
  const credentials = {
    async account() { accountCalls++; return f.api.authentication.session?.account; },
    async get(key) { return secrets.get(key); },
    async store(key, _name, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); },
  };
  const diagnostics = { append: value => log.push(value), show() {},
    failure: (operation, error) => errors.push({ operation, error }),
    async notify(_level, text) { notices.push(text); },
    async command(operation, run) { try { return await run(); } catch (error) { errors.push({ operation, error }); } },
  };
  f.api.window.showQuickPick = async choices => {
    f.calls.choices.push(choices);
    return choices[0]?.folder ? choices[selected] : choices[0];
  };
  f.api.window.showInputBox = async () => 'private fixture input';
  f.api.window.showWarningMessage = async (_text, _options, action) => action;
  const factory = options => {
    const state = { enabled: false, hosting: false, peers: [] };
    const saved = { version: 1, space: 'space', peers: [], host: { marker: 'idle-relay-' + 'a'.repeat(24) } };
    const manager = {
      options, stopped: 0, suspended: 0, hosted: [], resumed: [], reconnected: 0,
      status: () => ({ ...state }), async joinRequest() { return 'public request'; },
      async inspectRequest() { return { device: { fingerprint: 'a'.repeat(64) } }; },
      async inspectInvitation() { return { space: 'space', host: { fingerprint: 'b'.repeat(64) } }; },
      async sharingScope() { return state.enabled ? { active: true, mode: 'all' } : undefined; },
      async hostHistory(_text, scope) {
        manager.hosted.push(scope); state.enabled = true; state.hosting = true;
        await options.saveSpace('space'); await options.saveSession(saved);
        options.changed(state, false); return 'private invitation';
      },
      async joinHistory() { state.enabled = true; await options.saveSession(saved); options.changed(state, false); },
      async resume(value) { manager.resumed.push(value); state.enabled = true; options.changed(state, false); },
      async reconnect() { manager.reconnected++; },
      async devices() { return [{ fingerprint: 'a'.repeat(64) }]; },
      async revoke() { await options.saveSession(saved); },
      async changeScope() {},
      async stop() { manager.stopped++; state.enabled = false; options.changed(state, false); await options.saveSession(undefined); },
      async suspend() { manager.suspended++; state.enabled = false; options.changed(state, false); },
    };
    managers.push(manager); return manager;
  };
  delete require.cache[require.resolve('../out/sharing')];
  const { SharingHost, sharingKey } = loadWithVSCode('../../out/sharing', f.api);
  const key = index => sharingKey(f.api.workspace.workspaceFolders[index].uri,
    configuration.forResource(f.api.workspace.workspaceFolders[index].uri).chainDirectory);
  prepare({ f, credentials, key, secrets });
  const host = new SharingHost(f.context, configuration, credentials, diagnostics,
    async () => { tunnelCalls++; return {}; }, factory);
  return { f, host, managers, errors, notices, log, secrets, credentials, key,
    choose: index => { selected = index; }, accounts: () => accountCalls, tunnels: () => tunnelCalls,
    run: name => f.commands.get('idle.sharing.' + name)() };
}

test('sharing activation is offline and hosting binds the chosen folder with explicit scope and consent', async () => {
  const s = setup();
  try {
    await s.host.ready;
    assert.equal(s.accounts(), 0); assert.equal(s.tunnels(), 0);
    s.choose(1); await s.run('host');
    assert.deepEqual(s.errors, []);
    assert.equal(s.managers[0].options.chain, '/two/.editchain');
    assert.deepEqual(s.managers[0].hosted, [false], 'new records are the first scope choice');
    assert.equal(s.f.context.workspaceState.get('idle.sharing.enabled.' + s.key(0)), undefined);
    assert.equal(s.f.context.workspaceState.get('idle.sharing.enabled.' + s.key(1)), true);
    assert.ok(s.secrets.has(s.key(1)));
    assert.deepEqual(s.f.calls.clipboard, ['private invitation']);
    const notifications = [];
    const subscription = s.host.onDidChange(uri => notifications.push(uri.toString()));
    s.managers[0].options.changed(s.managers[0].status(), true);
    assert.deepEqual(notifications, ['file:///two']);
    await s.run('status');
    assert.ok(!JSON.stringify(s.log).includes('private invitation'));
    await s.run('stop');
    s.managers[0].options.changed(s.managers[0].status(), true);
    assert.deepEqual(notifications, ['file:///two'], 'retired receipts cannot refresh another binding');
    assert.equal(s.secrets.size, 0);
    assert.equal(s.f.context.workspaceState.get('idle.sharing.enabled.' + s.key(1)), undefined);
    subscription.dispose();
  } finally { await s.host.shutdown(); }
});

test('Stop during a pending approval prevents hosting and the late callback cannot save a session', async () => {
  const s = setup(), approval = deferred();
  let prompted = false;
  s.f.api.window.showWarningMessage = () => { prompted = true; return approval.promise; };
  try {
    const running = s.run('host');
    await until(() => prompted);
    await s.run('stop');
    approval.resolve('Approve device'); await running;
    assert.deepEqual(s.managers[0].hosted, []);
    await s.managers[0].options.saveSession({ version: 1, space: 'stale', peers: [] });
    assert.equal(s.secrets.size, 0);
    assert.equal(s.f.context.workspaceState.get('idle.sharing.enabled.' + s.key(0)), undefined);
    assert.equal(s.errors.at(-1).error.code, 'cancelled');
  } finally { await s.host.shutdown(); }
});

test('Stop also retires saved resumption while the initial account lookup is pending', async () => {
  const gate = deferred();
  const s = setup(({ f, credentials, key, secrets }) => {
    f.context.workspaceState.update('idle.sharing.enabled.' + key(0), true);
    secrets.set(key(0), JSON.stringify({ account: 'account', session: { version: 1, space: 'space', peers: [] } }));
    credentials.account = () => gate.promise;
  });
  try {
    const stopped = s.run('stop');
    gate.resolve({ id: 'account', label: 'Tester' });
    await stopped; await s.host.ready;
    assert.equal(s.managers.length, 0);
    assert.equal(s.secrets.size, 0);
    assert.equal(s.f.context.workspaceState.get('idle.sharing.enabled.' + s.key(0)), undefined);
  } finally { await s.host.shutdown(); }
});

test('chain changes and folder removal retire only their sharing owner', async () => {
  const s = setup();
  try {
    await s.run('host'); s.choose(1); await s.run('host');
    const [one, two] = s.managers;
    s.f.configuration.set('file:///one', { chainDirectory: 'new-chain' });
    s.f.events.configuration.fire({ affectsConfiguration: (key, uri) => key === 'idle.chainDirectory' && uri.toString() === 'file:///one' });
    await until(() => one.suspended === 1);
    await s.host.reset(true, new Set());
    assert.equal(two.suspended, 0);
    assert.equal(s.managers.length, 2, 'old approval cannot enable a new chain');
    assert.equal(s.f.context.workspaceState.get('idle.sharing.enabled.' + s.key(0)), undefined);
    s.f.api.workspace.workspaceFolders = s.f.api.workspace.workspaceFolders.slice(0, 1);
    s.f.events.folders.fire({});
    await until(() => two.suspended === 1);
    await s.host.reset(true, new Set());
    assert.equal(s.managers.length, 2);
  } finally { await s.host.shutdown(); }
});

test('saved sessions resume only for the approving account and survive a normal reload', async () => {
  const saved = { version: 1, space: 'space', peers: [] };
  const s = setup(({ f, key, secrets }) => {
    for (const index of [0, 1]) f.context.workspaceState.update('idle.sharing.enabled.' + key(index), true);
    secrets.set(key(0), JSON.stringify({ account: 'account', session: saved }));
    secrets.set(key(1), JSON.stringify({ account: 'another-account', session: saved }));
  });
  try {
    await s.host.ready;
    assert.deepEqual(s.managers[0].resumed, [saved]);
    assert.deepEqual(s.managers[1].resumed, []);
    assert.equal(s.errors.at(-1).error.code, 'account_changed');
    await s.host.shutdown();
    assert.equal(s.secrets.size, 2, 'suspension retains private sessions');
    assert.equal(s.f.context.workspaceState.get('idle.sharing.enabled.' + s.key(0)), true);
  } finally { await s.host.shutdown(); }
});

test('untrusted workspaces and denied device consent never enable sharing', async () => {
  const s = setup();
  try {
    await s.host.ready;
    s.f.api.workspace.isTrusted = false;
    await s.run('host');
    assert.equal(s.accounts(), 0); assert.equal(s.tunnels(), 0);
    assert.equal(s.errors.at(-1).error.code, 'workspace_untrusted');
    s.f.api.workspace.isTrusted = true;
    s.f.api.window.showWarningMessage = async () => undefined;
    await s.run('host');
    assert.deepEqual(s.managers[0].hosted, []);
    assert.equal(s.secrets.size, 0);
    assert.deepEqual(s.f.calls.clipboard, []);
  } finally { await s.host.shutdown(); }
});
