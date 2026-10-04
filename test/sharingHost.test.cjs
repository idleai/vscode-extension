const assert = require('node:assert/strict');
const test = require('node:test');
const { setup, deferred, until } = require('./helpers/sharingHost.cjs');

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
    assert.equal(s.secrets.size, 0, 'native persistence owns new sessions');
    assert.equal(s.f.context.workspaceState.get('idle.sharing.account.' + s.key(1)), 'account');
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
    await s.managers[0].options.saveEnabled(true);
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
    assert.equal(s.secrets.size, 1, 'only the acknowledged account is migrated; other accounts retain their old copy');
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

test('a retired migration cannot remove the replacement folder owner after a delayed SecretStorage read', async () => {
  const gate = deferred(); let delayed = true;
  const saved = JSON.stringify({ account: 'account', session: { version: 1, space: 'space', peers: [] } });
  const s = setup(({ f, credentials, key, secrets }) => {
    f.context.workspaceState.update('idle.sharing.enabled.' + key(0), true);
    secrets.set(key(0), saved);
    const original = credentials.get;
    credentials.get = (...args) => { if (delayed) { delayed = false; return gate.promise; } return original(...args); };
  });
  try {
    await until(() => s.managers.length === 1);
    await s.host.reset(true);
    assert.equal(s.managers.length, 2);
    gate.resolve(saved); await s.host.ready;
    const status = await s.run('status');
    assert.equal(status.length, 1);
    assert.equal(status[0].enabled, true);
  } finally { gate.resolve(saved); await s.host.shutdown(); }
});

test('Stop waits for prior workspace flag writes so a late completion cannot re-enable automatic sharing', async () => {
  const s = setup(), gate = deferred(); let writing = false;
  try {
    await s.run('request');
    const original = s.f.context.workspaceState.update;
    s.f.context.workspaceState.update = async (key, value) => {
      if (key.startsWith('idle.sharing.account.')) { writing = true; await gate.promise; }
      await original(key, value);
    };
    const saved = s.managers[0].options.saveEnabled(true);
    await until(() => writing);
    const stopped = s.run('stop');
    gate.resolve(); await Promise.all([saved, stopped]);
    assert.equal(s.f.context.workspaceState.get('idle.sharing.enabled.' + s.key(0)), undefined);
  } finally { gate.resolve(); await s.host.shutdown(); }
});

test('Stop clears native resumption even when that saved folder has no active sharing owner', async () => {
  const s = setup(({ f, key }) => {
    f.context.workspaceState.update('idle.sharing.account.' + key(0), 'account');
  });
  try {
    await s.host.ready;
    assert.equal(s.managers.length, 0);
    await s.run('stop');
    assert.equal(s.managers.length, 1);
    assert.equal(s.managers[0].stopped, 1);
  } finally { await s.host.shutdown(); }
});
