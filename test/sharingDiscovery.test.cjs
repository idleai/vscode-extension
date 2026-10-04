'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, deferred, until } = require('./helpers/sharingHost.cjs');

test('repository discovery requires explicit host approval and passes only its repository binding to Rust', async () => {
  const s = setup();
  try {
    await s.run('host');
    assert.deepEqual(s.f.calls.auth, [], 'hosting never requests discovery permissions');
    s.f.api.window.showInputBox = async () => 'owner/repository';
    await s.run('discovery');
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.managers[0].directories, ['owner/repository']);
    assert.deepEqual(s.f.calls.auth[0].slice(0, 2), ['github', ['repo']]);
    assert.equal(s.f.calls.auth[0][2].createIfNone, true);
    assert.deepEqual(s.f.context.workspaceState.get('idle.sharing.directory.' + s.key(0)), { repository: 'owner/repository', account: 'account' });
    assert.equal(await s.managers[0].options.credential('discovery'), 'TOKEN-NEVER-PRINT');
    assert.equal(s.f.calls.auth.at(-1)[2].silent, true);
    assert.ok(!JSON.stringify(s.log).includes('TOKEN-NEVER-PRINT'));
    s.f.api.window.showQuickPick = async choices => choices[0]?.folder ? choices[0] : choices[1];
    await s.run('discovery');
    assert.deepEqual(s.managers[0].directories, ['owner/repository', undefined]);
    assert.equal(await s.managers[0].options.credential('discovery'), undefined);
  } finally { await s.host.shutdown(); }
});

test('denied discovery consent and a different repository account cannot configure native publication', async () => {
  const s = setup();
  try {
    await s.run('host');
    s.f.api.window.showInputBox = async () => 'owner/repository';
    s.f.api.window.showWarningMessage = async () => undefined;
    await s.run('discovery');
    assert.deepEqual(s.f.calls.auth, []);
    assert.deepEqual(s.managers[0].directories, []);
    s.f.api.window.showWarningMessage = async (_message, _options, action) => action;
    s.f.api.authentication.getSession = async () => ({ account: { id: 'other-account' }, accessToken: 'other-private-token' });
    await s.run('discovery');
    assert.equal(s.errors.at(-1).error.code, 'account_changed');
    assert.deepEqual(s.managers[0].directories, []);
  } finally { await s.host.shutdown(); }
});

test('discovery credentials recheck trust after provider completion and reject a retired owner', async () => {
  const s = setup(), gate = deferred();
  try {
    await s.run('host');
    s.f.api.window.showInputBox = async () => 'owner/repository';
    await s.run('discovery');
    let requested = false;
    s.f.api.authentication.getSession = () => { requested = true; return gate.promise; };
    const credential = s.managers[0].options.credential('discovery');
    const denied = assert.rejects(credential, { code: 'workspace_untrusted' });
    await until(() => requested);
    s.f.api.workspace.isTrusted = false;
    gate.resolve({ account: { id: 'account' }, accessToken: 'late-private-token' }); await denied;
    s.f.api.workspace.isTrusted = true;
    await s.host.reset(false);
    await assert.rejects(s.managers[0].options.credential('management'), { code: 'cancelled' });
  } finally { await s.host.shutdown(); }
});
