const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: tick } = require('node:timers/promises');
const { fixture, loadWithVSCode } = require('./helpers/vscode.cjs');

const f = fixture();
const { HostCredentials, GITHUB_SCOPES, GITHUB_REPOSITORY_SCOPES } = loadWithVSCode('../../out/host/credentials', f.api);
const vscodeScopes = ['repo', 'workflow', 'user:email', 'read:user'];
const scopesKey = scopes => [...scopes].sort().join(' ');
const session = scopes => ({ id: 'existing', account: { id: 'account', label: 'Existing account' }, scopes,
  accessToken: 'PRIVATE-TOKEN-NEVER-LOG' });

function credentials(t) {
  const logs = [];
  const host = new HostCredentials(f.context.secrets, () => f.api.workspace.isTrusted, message => logs.push(message));
  t.after(() => host.dispose());
  return { host, logs };
}

function remote(t, choice = 'device', preferred = false, supported = true) {
  const changes = [];
  const prompts = [];
  const originalRemote = f.api.env.remoteName;
  f.api.env.remoteName = 'ssh-remote';
  t.after(() => { f.api.env.remoteName = originalRemote; });
  t.mock.method(f.api.workspace, 'getConfiguration', section => {
    assert.equal(section, 'github-authentication');
    return {
      inspect: key => { assert.equal(key, 'preferDeviceCodeFlow'); return supported ? { defaultValue: false } : undefined; },
      get: () => preferred,
      update: async (...args) => { changes.push(args); preferred = args[1]; },
    };
  });
  t.mock.method(f.api.window, 'showQuickPick', async (items, options) => {
    prompts.push({ items, options });
    return choice === 'cancel' ? undefined : items.find(item => item.device === (choice === 'device'));
  });
  return { changes, prompts };
}

test('repository access reuses VS Code GitHub scopes without another remote sign-in', async t => {
  const flow = remote(t);
  const { host, logs } = credentials(t);
  const existing = session(vscodeScopes);
  const requests = [];
  t.mock.method(f.api.authentication, 'getSession', async (provider, scopes, options) => {
    requests.push({ provider, scopes: [...scopes], options });
    assert.equal(options.silent, true, 'an authorized account must not start an interactive flow');
    return scopesKey(scopes) === scopesKey(vscodeScopes) ? existing : undefined;
  });
  assert.equal(await host.repositorySession(), existing);
  assert.equal(await host.repositorySession(true), existing);
  assert.equal(requests.length, 4);
  assert(requests.every(request => request.provider === 'github'));
  assert.equal(flow.prompts.length, 0);
  assert.equal(flow.changes.length, 0);
  assert(!logs.join('\n').includes(existing.accessToken));
});

test('basic identity is a read fallback and repository permission is requested only by connect', async t => {
  const { host } = credentials(t);
  const basic = session(GITHUB_SCOPES);
  const repository = session(GITHUB_REPOSITORY_SCOPES);
  const prompts = [];
  t.mock.method(f.api.authentication, 'getSession', async (_provider, scopes, options) => {
    if (options.createIfNone) { prompts.push([...scopes]); return repository; }
    return scopesKey(scopes) === scopesKey(GITHUB_SCOPES) ? basic : undefined;
  });
  assert.equal(await host.repositorySession(), basic);
  assert.equal(prompts.length, 0);
  assert.equal(await host.repositorySession(true), repository);
  assert.deepEqual(prompts, [[...GITHUB_REPOSITORY_SCOPES]], 'new login never requests workflow or email access to imitate an existing session');
});

test('concurrent views share sign-in and reconnect after VS Code has granted access', async t => {
  const { host, logs } = credentials(t);
  const created = session(GITHUB_REPOSITORY_SCOPES);
  let complete;
  const approval = new Promise(resolve => { complete = resolve; });
  let authorized = false;
  let prompts = 0;
  const reads = [];
  host.onDidChange(() => { reads.push(host.repositorySession()); });
  t.mock.method(f.api.authentication, 'getSession', async (_provider, _scopes, options) => {
    if (options.silent) return authorized ? created : undefined;
    prompts++;
    f.events.authentication.fire({ provider: { id: 'github' } });
    await approval;
    authorized = true;
    return created;
  });
  const first = host.repositorySession(true);
  const second = host.repositorySession(true);
  await tick();
  assert.equal(prompts, 1);
  assert.deepEqual(await Promise.all(reads), [undefined], 'the provider event arrives before extension consent finishes');
  complete();
  assert.deepEqual(await Promise.all([first, second]), [created, created]);
  assert.deepEqual(await Promise.all(reads), [undefined, created], 'completion starts a fresh authorized read even though the original view was retired');
  assert.equal(await host.repositorySession(true), created);
  assert.equal(prompts, 1, 'a later connect reuses the approved session');
  assert(!logs.join('\n').includes(created.accessToken));
});

test('account changes invalidate a delayed existing-session lookup even for an explicit connect', async t => {
  for (const interactive of [false, true]) {
    await t.test(String(interactive), async t => {
      const { host } = credentials(t);
      let resolve;
      t.mock.method(f.api.authentication, 'getSession', () => new Promise(done => { resolve = done; }));
      const read = host.repositorySession(interactive);
      f.events.authentication.fire({ provider: { id: 'github' } });
      resolve(session(GITHUB_REPOSITORY_SCOPES));
      await assert.rejects(read, { code: 'account_changed' });
    });
  }
});

test('provider failures have safe distinct messages and a failed sign-in can be retried', async t => {
  for (const [message, code] of [
    ['User did not consent to login.', 'authentication_cancelled'],
    ['Cancelled', 'authentication_cancelled'],
    ['Timed out: PRIVATE-CALLBACK-CODE', 'authentication_timeout'],
    ["No authentication provider 'github' is currently registered.", 'authentication_unavailable'],
    ['Unable to exchange PRIVATE-CALLBACK-CODE', 'authentication_failed'],
  ]) {
    await t.test(code + message.length, async t => {
      const { host, logs } = credentials(t);
      let attempts = 0;
      t.mock.method(f.api.authentication, 'getSession', async (_provider, _scopes, options) => {
        if (options.silent) return undefined;
        if (++attempts === 1) throw new Error(message);
        return session(GITHUB_REPOSITORY_SCOPES);
      });
      await assert.rejects(host.repositorySession(true), error => {
        assert.equal(error.code, code);
        assert(!error.message.includes('PRIVATE-CALLBACK-CODE'));
        return true;
      });
      assert.equal((await host.repositorySession(true)).account.id, 'account');
      assert.equal(attempts, 2);
      assert(!logs.join('\n').includes('PRIVATE-CALLBACK-CODE'));
    });
  }
});

test('remote device sign-in changes the provider preference only after the user chooses it', async t => {
  const flow = remote(t);
  const { host } = credentials(t);
  t.mock.method(f.api.authentication, 'getSession', async (_provider, _scopes, options) => {
    if (options.silent) return undefined;
    assert.deepEqual(flow.changes, [['preferDeviceCodeFlow', true, f.api.ConfigurationTarget.Global]]);
    return session(GITHUB_REPOSITORY_SCOPES);
  });
  await host.repositorySession(true);
  assert.equal(flow.prompts.length, 1);
  assert.match(flow.prompts[0].items[0].detail, /Saves this GitHub sign-in preference/);
  await host.repositorySession(true);
  assert.equal(flow.prompts.length, 1, 'the saved provider preference is honored without another choice');
});

test('remote browser choice, cancellation and older providers do not change user settings', async t => {
  for (const [choice, supported] of [['browser', true], ['cancel', true], ['device', false]]) {
    await t.test(choice + supported, async t => {
      const flow = remote(t, choice, false, supported);
      const { host } = credentials(t);
      let prompts = 0;
      t.mock.method(f.api.authentication, 'getSession', async (_provider, _scopes, options) => {
        if (options.silent) return undefined;
        prompts++;
        return session(GITHUB_REPOSITORY_SCOPES);
      });
      if (choice === 'cancel') {
        await assert.rejects(host.repositorySession(true), { code: 'authentication_cancelled' });
        assert.equal(prompts, 0);
      } else {
        await host.repositorySession(true);
        assert.equal(prompts, 1);
      }
      assert.equal(flow.changes.length, 0);
      assert.equal(flow.prompts.length, supported ? 1 : 0);
    });
  }
});

test('closing the credential host during approval cannot publish a completed sign-in', async t => {
  const { host } = credentials(t);
  let complete;
  const approval = new Promise(resolve => { complete = resolve; });
  let changed = 0;
  host.onDidChange(() => changed++);
  t.mock.method(f.api.authentication, 'getSession', async (_provider, _scopes, options) => options.silent ? undefined : approval);
  const pending = host.repositorySession(true);
  await tick();
  host.dispose();
  complete(session(GITHUB_REPOSITORY_SCOPES));
  await assert.rejects(pending, { code: 'host_closed' });
  assert.equal(changed, 0);
});

test('revoking workspace trust while choosing a flow prevents settings changes and sign-in', async t => {
  const flow = remote(t);
  const { host } = credentials(t);
  t.after(() => { f.api.workspace.isTrusted = true; });
  t.mock.method(f.api.window, 'showQuickPick', async choices => {
    f.api.workspace.isTrusted = false;
    return choices[0];
  });
  t.mock.method(f.api.authentication, 'getSession', async (_provider, _scopes, options) => {
    assert.equal(options.silent, true, 'trust is checked before starting interactive authentication');
    return undefined;
  });
  await assert.rejects(host.repositorySession(true), { code: 'workspace_untrusted' });
  assert.equal(flow.changes.length, 0);
});
