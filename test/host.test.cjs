const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: turn } = require('node:timers/promises');
const { HostEffects } = require('../out/host/effects');
const { WebviewBridge } = require('../out/host/messageBridge');
const { parseRequest } = require('../out/host/protocol');
const { fixture, view, uri, loadWithVSCode } = require('./helpers/vscode.cjs');
const f = fixture();
const { HostConfiguration, resolveNativePath } = loadWithVSCode('../../out/host/configuration', f.api);
const { HostCredentials } = loadWithVSCode('../../out/host/credentials', f.api);
const extension = loadWithVSCode('../../out/extension', f.api);

const request = (id, method, params = {}, session = 'current') => ({ protocol: 1, session, id, method, params });

test('host protocol refuses malformed, oversized and foreign-session input', () => {
  for (const input of [null, [], {}, request('1', 'ready', {}, 'old'), { ...request('1', 'ready'), protocol: 2 }, request('', 'ready'), request('1', 'ready', 'x'.repeat(1024 * 1024))]) {
    assert.equal(parseRequest(input, 'current'), undefined);
  }
  assert.equal(parseRequest(request('host:ready', 'host.ready'), 'current').id, 'host:ready');
});

test('closed views cancel pending operations and discard delayed replies', async () => {
  let resolve;
  let signal;
  const effects = new HostEffects(() => true);
  effects.register('slow', (_, context) => { signal = context.signal; return new Promise(done => { resolve = done; }); });
  const replies = [];
  const bridge = new WebviewBridge('current', effects, async value => { replies.push(value); return true; }, () => {});
  const pending = bridge.receive(request('1', 'slow'));
  bridge.dispose();
  assert.equal(signal.aborted, true);
  resolve({ evidence: 'late' });
  await pending;
  assert.deepEqual(replies, []);
});

test('effects are allowlisted, trust is checked per call, and failures do not expose raw exceptions', async () => {
  let trusted = false;
  const effects = new HostEffects(() => trusted);
  effects.register('native.example', () => { throw new Error('TOKEN-NEVER-PRINT'); });
  const replies = [];
  const bridge = new WebviewBridge('current', effects, async value => { replies.push(value); return true; }, () => {});
  assert.deepEqual(effects.available(), []);
  await bridge.receive(request('1', 'native.example'));
  assert.equal(replies.pop().error.code, 'workspace_untrusted');
  trusted = true;
  await bridge.receive(request('2', 'native.example'));
  assert.equal(replies[0].error.code, 'host_failure');
  assert.equal(JSON.stringify(replies).includes('TOKEN-NEVER-PRINT'), false);
  await bridge.receive(request('3', 'commands.execute'));
  assert.equal(replies.at(-1).error.code, 'unavailable');
  bridge.dispose();
});

test('duplicate in-flight IDs execute once and null successes keep their result field', async () => {
  let resolve;
  let calls = 0;
  const effects = new HostEffects(() => true);
  effects.register('wait', () => { calls++; return new Promise(done => { resolve = done; }); });
  const replies = [];
  const bridge = new WebviewBridge('current', effects, async value => { replies.push(value); return true; }, () => {});
  const pending = bridge.receive(request('1', 'wait'));
  await bridge.receive(request('1', 'wait'));
  assert.equal(calls, 1);
  resolve(null);
  await pending;
  assert.deepEqual(replies[0], { protocol: 1, session: 'current', id: '1', result: null });
  bridge.dispose();
});

test('a recreated document retires old requests even when VS Code reuses its resolved view', async () => {
  const pending = [];
  const effects = new HostEffects(() => true);
  effects.register('host.ready', () => ({}));
  effects.register('wait', (_, context) => new Promise(resolve => pending.push({ resolve, signal: context.signal })));
  const replies = [];
  const bridge = new WebviewBridge('current', effects, async value => { replies.push(value); return true; }, () => {});
  const old = bridge.receive(request('reused', 'wait'));
  await bridge.receive(request('host:ready', 'host.ready'));
  const current = bridge.receive(request('reused', 'wait'));
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve('old');
  await old;
  bridge.dispose();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve('current');
  await current;
  assert.deepEqual(replies.map(reply => reply.id), ['host:ready']);
});

test('file host configuration uses the explicit root and refuses virtual filesystems and relative executables', () => {
  const config = new HostConfiguration('/extension');
  f.configuration.set('file:///two', { chainDirectory: 'recorded' });
  assert.equal(config.forResource(uri('file:///two/src/file.rs')).chainDirectory, '/two/recorded');
  assert.equal(config.forResource(uri('file:///one/file.rs')).cwd, '/one');
  assert.throws(() => config.forResource(uri('file:///outside/file.rs')), /outside/);
  assert.throws(() => resolveNativePath('target/debug/service', '/extension', 'service'), /absolute/);
  assert.equal(resolveNativePath('', '/extension', 'service', 'linux', 'arm64', () => true), '/extension/bin/linux-arm64/service');
  f.api.workspace.workspaceFolders.push({ name: 'virtual', uri: uri('memfs:///virtual') });
  assert.throws(() => config.forResource(uri('memfs:///virtual/a')), /extension host/);
  f.api.env.remoteName = 'ssh-remote';
  f.api.workspace.workspaceFolders.push({ name: 'remote', uri: uri('vscode-remote://ssh-remote+server/home/repo') });
  assert.equal(config.forResource(uri('vscode-remote://ssh-remote+server/home/repo/a')).cwd, '/home/repo');
  f.api.env.remoteName = undefined;
  f.api.workspace.isTrusted = false;
  assert.throws(() => config.forResource(uri('file:///one/a')), /Trust/);
  f.api.workspace.isTrusted = true;
});

test('credentials are lazy, scoped, account-pinned and trust-gated', async () => {
  const credentials = new HostCredentials(f.context.secrets, () => f.api.workspace.isTrusted);
  assert.equal(f.calls.auth.length, 0);
  const account = await credentials.account();
  assert.deepEqual(account, { id: 'account', label: 'Tester' });
  const token = credentials.tokenProvider(account.id);
  assert.equal(await token(), f.api.authentication.session.accessToken);
  await credentials.store('a:b', 'c', 'value');
  assert.equal(await credentials.get('a', 'b:c'), undefined);
  assert.equal(await credentials.get('a:b', 'c'), 'value');
  const original = f.api.authentication.session;
  f.api.authentication.session = { ...original, account: { id: 'other', label: 'Other' } };
  await assert.rejects(token(), /account changed/);
  f.api.authentication.session = original;
  f.api.workspace.isTrusted = false;
  await assert.rejects(token(), /Trust/);
  assert.throws(() => credentials.get('a', 'b'), /Trust/);
  f.api.workspace.isTrusted = true;
  credentials.dispose();
});

test('credentials reject a session that resolves after an account-change event', async () => {
  const original = f.api.authentication.getSession;
  const credentials = new HostCredentials(f.context.secrets, () => true);
  let resolve;
  f.api.authentication.getSession = () => new Promise(done => { resolve = done; });
  try {
    const token = credentials.tokenProvider('account')();
    f.events.authentication.fire({ provider: { id: 'github' } });
    resolve(f.api.authentication.session);
    await assert.rejects(token, /account changed/);
  } finally { credentials.dispose(); f.api.authentication.getSession = original; }
});

test('activation and views share extension-lifetime services without acquiring credentials or starting processes', async () => {
  const authCalls = f.calls.auth.length;
  const host = extension.activate(f.context);
  let nativeDisposed = 0;
  const disposeNative = host.native.dispose.bind(host.native);
  host.native.dispose = () => { nativeDisposed++; disposeNative(); };
  assert.equal(f.calls.auth.length, authCalls);
  assert.equal(f.commands.has('idle.signIn'), true);
  assert.equal(typeof host.native.startPeer, 'function');
  assert.equal(typeof host.transport.bridgeDuplex, 'function');
  const first = view();
  f.calls.providers[0].provider.resolveWebviewView(first);
  const session = first.webview.html.match(/data-host-session="([^"]+)"/)[1];
  first.messages.fire(request('host:ready', 'host.ready', {}, session));
  await turn();
  assert.ok(first.posted[0].result.capabilities.includes('external.open'));
  assert.ok(!first.posted[0].result.capabilities.includes('credentials.get'));
  first.dispose();
  assert.equal(nativeDisposed, 0);
  const second = view();
  f.calls.providers[0].provider.resolveWebviewView(second);
  assert.notEqual(second.webview.html.match(/data-host-session="([^"]+)"/)[1], session);
  assert.equal(f.calls.auth.length, authCalls);
  await assert.rejects(host.effects.execute('external.open', { url: 'command:workbench.action.closeWindow' }, { session, signal: new AbortController().signal }), /Only HTTP/);
  await extension.deactivate();
  assert.equal(nativeDisposed, 1);
  for (const disposable of f.context.subscriptions) disposable.dispose();
  assert.equal(JSON.stringify(f.calls.output).includes('TOKEN-NEVER-PRINT'), false);
});
