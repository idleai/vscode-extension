'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { Duplex, PassThrough } = require('node:stream');
const { CancellationToken, CancellationTokenSource } = require('vscode-jsonrpc');
const { ConnectionStatus } = require('@microsoft/dev-tunnels-connections');
const { SecureStream, SshAlgorithms, SshClientSession, SshServerSession, SshSessionConfiguration,
  SshStream, NodeStream, SshProtocolExtensionNames } = require('@microsoft/dev-tunnels-ssh');
const { DevTunnelsAdapters } = require('../out/host/devTunnels');
const { defaultSdk, managementClient } = require('../out/host/devTunnels/sdk');
const { hostDescriptor, validateEndpoint } = require('../out/host/devTunnels/contracts');
const { encryptedHostStream, encryptedStream, encryptedV1SessionId, safeFailure } = require('../out/host/devTunnels/security');

const PORT = 43188;
let key;
let publicKey;
before(async () => {
  key = await SshAlgorithms.publicKey.ecdsaSha2Nistp256.generateKeyPair();
  publicKey = (await key.getPublicKeyBytes()).toString('base64');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected operation did not finish.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function event() {
  const handlers = new Set();
  return { on(callback) { handlers.add(callback); return { dispose() { handlers.delete(callback); } }; },
    emit(value) { for (const handler of handlers) handler(value); } };
}

function endpoint() {
  return { tunnelId: 'test-tunnel', clusterId: 'use', hostId: 'host',
    clientRelayUri: 'wss://use.rel.tunnels.api.visualstudio.com/tunnel', hostPublicKeys: [publicKey] };
}

function descriptor() { return { endpoint: endpoint(), connectToken: 'opaque-connect-grant', port: PORT }; }

function fixture(behavior = {}) {
  const state = { calls: [], tunnels: [], pending: new Set(), sdkCalls: 0, hostDisposals: 0, clientDisposals: 0, deleted: [] };
  const hostEvents = event();
  const clientEvents = event();
  const statusEvents = event();
  const journal = {
    async remember(marker) {
      state.calls.push(['remember', marker]);
      await behavior.rememberGate;
      if (behavior.rememberError) throw behavior.rememberError;
      state.pending.add(marker);
    },
    async forget(marker) { state.calls.push(['forget', marker]); state.pending.delete(marker); },
  };
  function management(kind) {
    state.sdkCalls++;
    let disposed = false;
    const use = () => assert.equal(disposed, false, 'A disposed management client cannot be reused.');
    return {
      async createTunnel(value, options, token) {
        use(); state.calls.push(['create', value, options, token]);
        await behavior.createGate;
        if (behavior.createError) throw behavior.createError;
        const tunnel = { ...value, tunnelId: 'test-tunnel', clusterId: 'use' };
        state.tunnels.push(tunnel);
        return tunnel;
      },
      async getTunnel(locator, options) {
        use(); state.calls.push(['get', locator, options]);
        const tunnel = state.tunnels.find(value => value.tunnelId === locator.tunnelId);
        if (!tunnel) return null;
        return { ...tunnel, accessTokens: { connect: 'opaque-connect-grant', host: 'private-host-grant' },
          endpoints: [{ ...endpoint(), connectionMode: 'TunnelRelay' }] };
      },
      async listTunnels(_cluster, _domain, options, token) {
        use(); state.calls.push(['list', options, token.isCancellationRequested]);
        if (behavior.listError) throw behavior.listError;
        return [...state.tunnels];
      },
      async deleteTunnel(locator, _options, token) {
        use(); state.calls.push(['delete', locator, token.isCancellationRequested]);
        if (behavior.deleteFailures > 0) { behavior.deleteFailures--; throw new Error('secret-delete-error'); }
        state.deleted.push(locator.tunnelId);
        state.tunnels = state.tunnels.filter(value => value.tunnelId !== locator.tunnelId);
        return true;
      },
      async dispose() {
        state.calls.push(['management-dispose', kind]);
        if (kind === 'cleanup' && behavior.cleanupDisposeFailures > 0) {
          behavior.cleanupDisposeFailures--; throw new Error('secret-management-error');
        }
        disposed = true;
      },
    };
  }
  const host = {
    hostPublicKeys: [], connectionProtocol: 'tunnel-relay-host-v2-dev',
    forwardedPortConnecting: hostEvents.on, connectionStatusChanged: statusEvents.on,
    async connect(tunnel, options) {
      state.calls.push(['host-connect', tunnel, options]);
      statusEvents.emit({ status: ConnectionStatus.Connecting });
      await behavior.hostConnectGate;
      if (behavior.hostConnectError) {
        statusEvents.emit({ status: ConnectionStatus.Disconnected });
        throw behavior.hostConnectError;
      }
      statusEvents.emit({ status: ConnectionStatus.Connected });
    },
    async dispose() {
      state.hostDisposals++;
      await behavior.hostDisposeGate;
      if (behavior.hostDisposeFailures > 0) { behavior.hostDisposeFailures--; throw new Error('secret-host-dispose'); }
    },
  };
  const client = {
    connectionProtocol: behavior.v1 ? 'tunnel-relay-client' : 'tunnel-relay-client-v2-dev',
    forwardedPortConnecting: clientEvents.on,
    async connect(tunnel, options) { state.calls.push(['client-connect', tunnel, options]); await behavior.clientConnectGate; },
    async waitForForwardedPort(port) { state.calls.push(['wait-port', port]); },
    async connectToForwardedPort(port) {
      state.calls.push(['connect-port', port]);
      return behavior.stream(port, clientEvents);
    },
    async dispose() {
      state.clientDisposals++;
      if (behavior.clientDisposeFailures > 0) { behavior.clientDisposeFailures--; throw new Error('secret-client-dispose'); }
    },
  };
  const sdk = {
    createHost() { host.hostPublicKeys = [publicKey]; return { management: management('host'), host }; },
    createManagement() { return management('cleanup'); },
    createClient() { state.sdkCalls++; return client; },
  };
  const adapters = new DevTunnelsAdapters({ githubToken: async () => { throw new Error('No account required.'); },
    journal, sdk, timeoutMs: behavior.timeoutMs ?? 3000, cleanupTimeoutMs: 1000 });
  return { state, adapters, host, client, hostEvents, clientEvents };
}

function wires() {
  const a = new PassThrough(), b = new PassThrough();
  return [Duplex.from({ readable: a, writable: b }), Duplex.from({ readable: b, writable: a })];
}

async function securePair() {
  const [hostWire, clientWire] = wires();
  const server = new SecureStream(hostWire, { publicKeys: [key] });
  const peer = new SecureStream(clientWire, { username: 'tunnel' });
  server.on('error', () => {}); peer.on('error', () => {});
  server.onAuthenticating(args => { args.authenticationPromise = Promise.resolve({}); });
  peer.onAuthenticating(args => {
    args.authenticationPromise = args.publicKey.getPublicKeyBytes().then(bytes => bytes.toString('base64') === publicKey ? {} : null);
  });
  await Promise.all([server.connect(), peer.connect()]);
  return { server, peer, hostWire, clientWire, dispose() { server.dispose(); peer.dispose(); } };
}

async function sshPair(configure = () => {}) {
  const [hostWire, clientWire] = wires();
  const config = new SshSessionConfiguration();
  configure(config);
  const sessions = config.protocolExtensions.includes(SshProtocolExtensionNames.sessionReconnect) ? [] : undefined;
  const server = new SshServerSession(config, sessions), peer = new SshClientSession(config);
  server.credentials = { publicKeys: [key] };
  server.onAuthenticating(args => { args.authenticationPromise = Promise.resolve({}); });
  peer.onAuthenticating(args => { args.authenticationPromise = args.publicKey.getPublicKeyBytes().then(bytes => bytes.toString('base64') === publicKey ? {} : null); });
  await Promise.all([server.connect(new NodeStream(hostWire)), peer.connect(new NodeStream(clientWire))]);
  assert.equal(await peer.authenticate({ username: 'tunnel' }), true);
  const [incoming, outgoing] = await Promise.all([server.acceptChannel(), peer.openChannel()]);
  const streams = [new SshStream(incoming), new SshStream(outgoing)];
  streams.forEach(stream => stream.on('error', () => {}));
  return { streams, server, peer, dispose() { server.dispose(); peer.dispose(); } };
}

test('adapter construction and unused shutdown do not create SDK clients or request credentials', async () => {
  const f = fixture();
  f.adapters.createHost({ port: PORT, incoming() {} });
  f.adapters.createClient();
  assert.equal(f.state.sdkCalls, 0);
  await f.adapters.shutdown();
  assert.equal(f.state.sdkCalls, 0);
  assert.throws(() => f.adapters.createClient(), /shut down/);
});

test('installed SDK constructs and disposes host/client with the pinned uuid override without network', async () => {
  let tokens = 0;
  const services = defaultSdk.createHost(async () => { tokens++; return 'unused-token'; });
  const client = defaultSdk.createClient();
  await services.host.dispose();
  await client.dispose();
  await services.management.dispose();
  assert.equal(tokens, 0);
});

test('management requests obtain fresh GitHub authorization without logging credentials', async () => {
  let serial = 0;
  const management = managementClient(async () => `opaque-${++serial}`);
  const headers = [];
  management.adapter = async config => {
    headers.push(config.headers.get('Authorization'));
    return { status: 200, statusText: 'OK', config, headers: {}, data: { tunnelId: 'test-tunnel' } };
  };
  try {
    await management.getTunnel({ tunnelId: 'test-tunnel', clusterId: 'use' });
    await management.getTunnel({ tunnelId: 'test-tunnel', clusterId: 'use' });
    assert.deepEqual(headers, ['github opaque-1', 'github opaque-2']);
  } finally { await management.dispose(); }
});

test('hosting uses an owned private resource, disabled local forwarding, and an opaque connect-only descriptor', async () => {
  const f = fixture(), statuses = [];
  const host = f.adapters.createHost({ port: PORT, incoming() {}, onStatus: status => statuses.push(status) });
  await host.start();
  const create = f.state.calls.find(call => call[0] === 'create');
  assert.equal(create[1].accessControl, undefined);
  assert.equal(create[1].name, undefined);
  assert.deepEqual(create[1].ports, [{ portNumber: PORT, protocol: 'auto' }]);
  assert.deepEqual(create[2].tokenScopes, ['host']);
  assert.equal(f.host.forwardConnectionsToLocalPorts, false);
  assert.equal(f.host.enableE2EEncryption, true);
  assert.deepEqual(f.state.calls.find(call => call[0] === 'host-connect')[2], { enableRetry: false, enableReconnect: false });
  assert.deepEqual(await host.descriptor(), descriptor());
  assert.deepEqual(statuses, ['connecting', 'connected']);
  assert.equal(f.state.pending.has(host.lease().marker), true);
  await host.stop();
  await host.stop();
  assert.deepEqual(f.state.deleted, ['test-tunnel']);
  assert.equal(f.state.pending.size, 0);
  assert.equal(f.state.calls.find(call => call[0] === 'delete')[2], false);
  await f.adapters.shutdown();
});

test('shutdown suspends a completed host, and explicit stop subsequently removes its saved lease', async () => {
  const f = fixture();
  const host = f.adapters.createHost({ port: PORT, incoming() {} });
  await host.start();
  await f.adapters.shutdown();
  assert.equal(f.state.hostDisposals, 1);
  assert.deepEqual(f.state.deleted, []);
  assert.equal(f.state.pending.size, 1);
  await host.stop();
  assert.deepEqual(f.state.deleted, ['test-tunnel']);
  assert.equal(f.state.pending.size, 0);
});

test('a resumed host verifies the saved resource label and reuses the tunnel', async () => {
  const f = fixture();
  const first = f.adapters.createHost({ port: PORT, incoming() {} });
  await first.start();
  const lease = first.lease();
  await first.suspend();
  const second = f.adapters.createHost({ port: PORT, incoming() {} });
  await second.start(lease);
  assert.equal(f.state.calls.filter(call => call[0] === 'create').length, 1);
  await second.stop();
  await f.adapters.shutdown();
});

test('a connect rejection still deletes the tunnel after a Disconnected status, using safe diagnostics', async () => {
  const f = fixture({ hostConnectError: { response: { status: 403, data: 'secret-body' }, message: 'secret-token' } });
  const host = f.adapters.createHost({ port: PORT, incoming() {} });
  await assert.rejects(host.start(), error => /HTTP 403/.test(error.message) && !/secret/.test(error.message));
  assert.deepEqual(f.state.deleted, ['test-tunnel']);
  assert.equal(f.state.pending.size, 0);
  await f.adapters.shutdown();
});

test('ownership rejection and pre-cancellation prevent any cloud SDK work', async () => {
  for (const cancelled of [true, false]) {
    const f = fixture(cancelled ? {} : { rememberError: new Error('foreign-owner-secret') });
    const source = new CancellationTokenSource();
    const token = source.token;
    if (cancelled) source.cancel();
    const host = f.adapters.createHost({ port: PORT, incoming() {} });
    await assert.rejects(host.start(undefined, token), error => !/foreign-owner-secret/.test(error.message));
    assert.equal(f.state.sdkCalls, 0);
    await f.adapters.shutdown();
    source.dispose();
  }
});

test('late create completion after stop deletes the new resource and cannot start hosting', async () => {
  const gate = deferred();
  const f = fixture({ createGate: gate.promise });
  const host = f.adapters.createHost({ port: PORT, incoming() {} });
  const starting = assert.rejects(host.start(), /cancelled|cleanup is pending/);
  await until(() => f.state.calls.some(call => call[0] === 'create'));
  await assert.rejects(host.stop(), /outcome is uncertain/);
  await starting;
  gate.resolve();
  await until(() => f.state.deleted.length === 1 && f.state.pending.size === 0);
  assert.equal(f.state.calls.some(call => call[0] === 'host-connect'), false);
  await f.adapters.shutdown();
});

test('late journal ownership after stop is released without creating a tunnel', async () => {
  const gate = deferred();
  const f = fixture({ rememberGate: gate.promise });
  const host = f.adapters.createHost({ port: PORT, incoming() {} });
  const starting = assert.rejects(host.start(), /cancelled/);
  await until(() => f.state.calls.some(call => call[0] === 'remember'));
  await host.stop();
  await starting;
  gate.resolve();
  await until(() => f.state.calls.some(call => call[0] === 'forget'));
  assert.equal(f.state.pending.size, 0);
  assert.equal(f.state.calls.some(call => call[0] === 'create'), false);
  await f.adapters.shutdown();
});

test('late host connect completion receives another disposal after shutdown', async () => {
  const gate = deferred();
  const f = fixture({ hostConnectGate: gate.promise });
  const host = f.adapters.createHost({ port: PORT, incoming() {} });
  const starting = assert.rejects(host.start(), /cancelled/);
  await until(() => f.state.calls.some(call => call[0] === 'host-connect'));
  await f.adapters.shutdown();
  await starting;
  assert.equal(f.state.hostDisposals, 1);
  gate.resolve();
  await until(() => f.state.hostDisposals === 2);
  assert.equal(f.state.deleted.length, 1);
});

test('definitive create rejections clear absent resources; uncertain outcomes retain cleanup ownership', async () => {
  for (const status of [400, 403, 401]) {
    const f = fixture({ createError: { response: { status } } });
    const host = f.adapters.createHost({ port: PORT, incoming() {} });
    await assert.rejects(host.start(), new RegExp(`HTTP ${status}`));
    assert.equal(f.state.pending.size, status === 401 ? 1 : 0);
    if (status === 401) await assert.rejects(f.adapters.shutdown(), /cleanup can be retried/);
    else await f.adapters.shutdown();
  }
});

test('failed deletion, host disposal and cleanup-management disposal can be retried independently', async () => {
  for (const failure of ['deleteFailures', 'hostDisposeFailures', 'cleanupDisposeFailures']) {
    const f = fixture({ [failure]: 1 });
    const host = f.adapters.createHost({ port: PORT, incoming() {} });
    await host.start();
    await assert.rejects(host.stop(), error => !/secret/.test(error.message));
    await host.stop();
    assert.deepEqual(f.state.deleted, ['test-tunnel']);
    assert.equal(f.state.pending.size, 0);
    await f.adapters.shutdown();
  }
});

test('completed handles are retired while failed cleanup is retained for shutdown retry', async () => {
  const f = fixture();
  const host = f.adapters.createHost({ port: PORT, incoming() {} });
  await host.start();
  await host.stop();
  host.suspend = async () => { throw new Error('A retired host must not be revisited.'); };
  const client = f.adapters.createClient();
  await client.stop();
  client.stop = async () => { throw new Error('A retired client must not be revisited.'); };
  await f.adapters.shutdown();
  const retry = fixture({ deleteFailures: 1 });
  const retained = retry.adapters.createHost({ port: PORT, incoming() {} });
  await retained.start();
  await assert.rejects(retained.stop());
  await retry.adapters.shutdown();
  assert.deepEqual(retry.state.deleted, ['test-tunnel']);
  assert.equal(retry.state.pending.size, 0);
});

test('simultaneous suspend and stop share teardown and delete only once', async () => {
  const gate = deferred();
  const f = fixture({ hostDisposeGate: gate.promise });
  const host = f.adapters.createHost({ port: PORT, incoming() {} });
  await host.start();
  const suspend = host.suspend();
  await until(() => f.state.hostDisposals === 1);
  const stop = host.stop();
  gate.resolve();
  await Promise.all([suspend, stop]);
  assert.equal(f.state.hostDisposals, 1);
  assert.deepEqual(f.state.deleted, ['test-tunnel']);
  await f.adapters.shutdown();
});

test('saved cleanup resolves ownership labels, ignores unrelated tunnels and rejects ambiguity', async () => {
  const f = fixture();
  const marker = `idle-relay-${'a'.repeat(24)}`;
  f.state.tunnels.push({ tunnelId: 'foreign', clusterId: 'use', labels: ['idle-relay'] });
  f.state.tunnels.push({ tunnelId: 'owned', clusterId: 'use', labels: [marker] });
  await f.adapters.cleanup(marker);
  assert.deepEqual(f.state.deleted, ['owned']);
  f.state.tunnels.push({ tunnelId: 'duplicate-1', clusterId: 'use', labels: [marker] });
  f.state.tunnels.push({ tunnelId: 'duplicate-2', clusterId: 'use', labels: [marker] });
  await assert.rejects(f.adapters.cleanup(marker), /Ambiguous/);
  assert.equal(f.state.pending.size, 1);
  f.state.tunnels = f.state.tunnels.filter(tunnel => tunnel.tunnelId !== 'duplicate-2');
  await f.adapters.cleanup(marker);
  await f.adapters.shutdown();
});

test('saved cleanup retries management disposal without restoring an already removed journal marker', async () => {
  const f = fixture({ cleanupDisposeFailures: 1 });
  const marker = `idle-relay-${'b'.repeat(24)}`;
  f.state.tunnels.push({ tunnelId: 'owned', clusterId: 'use', labels: [marker] });
  await assert.rejects(f.adapters.cleanup(marker), /Closing relay cleanup management failed/);
  await f.adapters.cleanup(marker);
  assert.deepEqual(f.state.deleted, ['owned']);
  assert.equal(f.state.pending.size, 0);
  await f.adapters.shutdown();
});

test('shutdown cancels cleanup waiting for ownership and prevents late SDK creation', async () => {
  const gate = deferred(), marker = `idle-relay-${'c'.repeat(24)}`;
  const f = fixture({ rememberGate: gate.promise });
  const cleanup = assert.rejects(f.adapters.cleanup(marker), /cancelled/);
  await until(() => f.state.calls.some(call => call[0] === 'remember'));
  await f.adapters.shutdown();
  await cleanup;
  gate.resolve();
  await until(() => f.state.pending.has(marker));
  assert.equal(f.state.sdkCalls, 0, 'Late ownership preserves the cleanup record without opening a transport.');
});

test('endpoint validation rejects missing pins, foreign hosts, userinfo, loopback and insecure schemes', () => {
  for (const uri of ['http://use.rel.tunnels.api.visualstudio.com/tunnel', 'wss://127.0.0.1/tunnel',
    'wss://localhost/tunnel', 'wss://use.rel.tunnels.api.visualstudio.com.evil.test/tunnel',
    'wss://user:secret@use.rel.tunnels.api.visualstudio.com/tunnel',
    'wss://use.rel.tunnels.api.visualstudio.com:8443/tunnel']) {
    assert.throws(() => validateEndpoint({ ...endpoint(), clientRelayUri: uri }), /Microsoft/);
  }
  assert.throws(() => validateEndpoint({ ...endpoint(), hostPublicKeys: [] }), /Invalid/);
  const tunnel = { tunnelId: 'test-tunnel', clusterId: 'use', accessTokens: { connect: 'opaque' },
    endpoints: [{ ...endpoint(), connectionMode: 'TunnelRelay', hostPublicKeys: ['d3Jvbmcta2V5'] }] };
  assert.throws(() => hostDescriptor(tunnel, [publicKey], PORT), /matching the host key/);
});

test('real V2 SecureStreams carry bytes and only the exact verified client stream can be returned', { timeout: 10000 }, async () => {
  const pair = await securePair();
  const f = fixture({ async stream(port, events) {
    const incoming = { port, stream: pair.clientWire, transformPromise: Promise.resolve(pair.peer) };
    events.emit(incoming);
    return incoming.transformPromise;
  } });
  try {
    const client = f.adapters.createClient();
    const stream = await client.connect(descriptor());
    assert.equal(stream, pair.peer);
    assert.equal(stream.isPaused(), true);
    assert.equal(f.client.acceptLocalConnectionsForForwardedPorts, false);
    assert.equal(f.client.enableE2EEncryption, true);
    const connected = f.state.calls.find(call => call[0] === 'client-connect')[1];
    assert.deepEqual(connected.endpoints[0].hostPublicKeys, [publicKey]);
    assert.deepEqual(connected.accessTokens, { connect: 'opaque-connect-grant' });
    const received = new Promise(resolve => pair.server.once('data', resolve));
    stream.write(Buffer.from('native bytes'));
    assert.deepEqual(await received, Buffer.from('native bytes'));
    await client.stop();
    assert.equal(pair.peer.isClosed, true, 'Stopping the client must dispose its SDK SSH session.');
  } finally { await f.adapters.shutdown(); pair.dispose(); }
});

test('host hands native consumers a paused SecureStream and closes transforms resolving after suspend', async () => {
  const pair = await securePair(), latePair = await securePair(), accepted = [];
  const f = fixture();
  const host = f.adapters.createHost({ port: PORT, incoming: stream => accepted.push(stream) });
  await host.start();
  try {
    const incoming = { port: PORT, stream: pair.hostWire, transformPromise: Promise.resolve(pair.server) };
    f.hostEvents.emit(incoming);
    assert.equal(await incoming.transformPromise, pair.server);
    assert.equal(accepted[0], pair.server);
    assert.equal(accepted[0].isPaused(), true);
    const gate = deferred();
    const late = { port: PORT, stream: new PassThrough(), transformPromise: gate.promise };
    f.hostEvents.emit(late);
    await host.suspend();
    assert.equal(pair.server.isClosed, true, 'Suspending the host must dispose its SDK SSH session.');
    gate.resolve(latePair.server);
    assert.equal(await late.transformPromise, null);
    assert.equal(latePair.server.destroyed, true);
    assert.equal(latePair.server.isClosed, true);
    assert.equal(accepted.length, 1);
    await host.stop();
  } finally { pair.dispose(); latePair.dispose(); await f.adapters.shutdown(); }
});

test('SDK V2 transport closure reaches the native Duplex consumer and disposes encryption', async () => {
  const pair = await securePair();
  const f = fixture({ async stream(port, events) {
    const incoming = { port, stream: pair.clientWire, transformPromise: Promise.resolve(pair.peer) };
    events.emit(incoming);
    return incoming.transformPromise;
  } });
  try {
    const client = f.adapters.createClient();
    const stream = await client.connect(descriptor());
    const closed = new Promise(resolve => stream.once('close', resolve));
    pair.server.dispose();
    await closed;
    assert.equal(stream.destroyed, true);
    assert.equal(pair.peer.isClosed, true);
    await client.stop();
  } finally { await f.adapters.shutdown(); pair.dispose(); }
});

test('destroying a native V2 stream also disposes its SDK session and raw transport', async () => {
  const pair = await securePair();
  try {
    const stream = await encryptedStream({ port: PORT, stream: pair.clientWire,
      transformPromise: Promise.resolve(pair.peer) }, PORT);
    const closed = new Promise(resolve => pair.clientWire.once('close', resolve));
    stream.destroy();
    await closed;
    assert.equal(pair.peer.isClosed, true);
    assert.equal(pair.clientWire.destroyed, true);
  } finally { pair.dispose(); }
});

test('V1 SSH disconnect closes the returned Duplex even when the SDK session supports reconnect', async () => {
  const pair = await sshPair(config => config.protocolExtensions.push(SshProtocolExtensionNames.sessionReconnect));
  try {
    const stream = pair.streams[1];
    encryptedV1SessionId(stream);
    const closed = new Promise(resolve => stream.once('close', resolve));
    stream.resume();
    pair.server.dispose();
    await closed;
    assert.equal(stream.destroyed, true);
    assert.equal(pair.peer.isClosed, true);
  } finally { pair.dispose(); }
});

test('V1 channel closure preserves buffered final bytes for a paused native reader', async () => {
  const pair = await sshPair();
  try {
    const [host, stream] = pair.streams;
    encryptedV1SessionId(stream);
    const payload = Buffer.from('Final frame before graceful peer closure.');
    await new Promise(resolve => host.end(payload, resolve));
    await until(() => stream.channel.isClosed);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.equal(stream.readableEnded, true);
  } finally { pair.dispose(); }
});

test('the actual SDK refuses a V1 host key different from the caller-approved pin', { timeout: 10000 }, async () => {
  const [hostWire, clientWire] = wires();
  const server = new SshServerSession(new SshSessionConfiguration());
  server.credentials = { publicKeys: [key] };
  server.onAuthenticating(args => { args.authenticationPromise = Promise.resolve({}); });
  const realClient = defaultSdk.createClient();
  realClient.streamFactory = { async createRelayStream() {
    return { stream: new NodeStream(clientWire), protocol: 'tunnel-relay-client' };
  } };
  const adapters = new DevTunnelsAdapters({
    githubToken: async () => { throw new Error('No account should be accessed.'); },
    journal: { async remember() {}, async forget() {} },
    sdk: { ...defaultSdk, createClient: () => realClient }, timeoutMs: 3000,
  });
  const connected = server.connect(new NodeStream(hostWire));
  try {
    await assert.rejects(adapters.createClient().connect({ ...descriptor(),
      endpoint: { ...endpoint(), hostPublicKeys: ['d3Jvbmcta2V5'] } }), /Connecting relay client failed/);
    await connected;
  } finally { await adapters.shutdown(); server.dispose(); }
});

test('one secure V2 transform cannot approve a separate raw returned stream', async () => {
  const pair = await securePair();
  const raw = new PassThrough();
  const f = fixture({ async stream(port, events) {
    const verified = { port, stream: pair.clientWire, transformPromise: Promise.resolve(pair.peer) };
    events.emit(verified);
    await verified.transformPromise;
    return raw;
  } });
  try {
    await assert.rejects(f.adapters.createClient().connect(descriptor()), /unencrypted/);
    assert.equal(raw.destroyed, true);
  } finally { await f.adapters.shutdown(); pair.dispose(); }
});

test('host rejects raw V2, unrelated ports and unknown relay protocols', async () => {
  const raw = new PassThrough();
  await assert.rejects(encryptedStream({ port: PORT, stream: raw, transformPromise: Promise.resolve(raw) }, PORT), /encrypted V2/);
  assert.equal(raw.destroyed, true);
  const pair = await securePair();
  try {
    await assert.rejects(encryptedHostStream({ port: PORT, stream: pair.hostWire,
      transformPromise: Promise.resolve(pair.server) }, 'future-unsupported-protocol', PORT), /Unsupported/);
    assert.equal(pair.hostWire.destroyed, true);
  } finally { pair.dispose(); }
  const wrongPort = new PassThrough();
  await assert.rejects(encryptedHostStream({ port: PORT + 1, stream: wrongPort }, 'tunnel-relay-host', PORT), /port/);
  assert.equal(wrongPort.destroyed, true);
});

test('V1 requires authentication, encryption and integrity on the actual SSH session', { timeout: 10000 }, async () => {
  const pair = await sshPair();
  try {
    assert.deepEqual(encryptedV1SessionId(pair.streams[0]), encryptedV1SessionId(pair.streams[1]));
    const f = fixture({ v1: true, stream: async () => pair.streams[1] });
    assert.equal(await f.adapters.createClient().connect(descriptor()), pair.streams[1]);
    await f.adapters.shutdown();
  } finally { pair.dispose(); }
  for (const configure of [config => config.encryptionAlgorithms.splice(0, Infinity, null), config => {
    config.encryptionAlgorithms.splice(0, Infinity, SshAlgorithms.encryption.aes256Ctr);
    config.hmacAlgorithms.splice(0, Infinity, null);
  }]) {
    const insecure = await sshPair(configure);
    try { assert.throws(() => encryptedV1SessionId(insecure.streams[1]), /authenticated, encrypted/); }
    finally { insecure.dispose(); }
  }
});

test('late client streams are destroyed after cancellation', async () => {
  const gate = deferred(), raw = new PassThrough();
  const f = fixture({ stream: async () => { await gate.promise; return raw; } });
  const client = f.adapters.createClient();
  const connecting = assert.rejects(client.connect(descriptor()), /cancelled/);
  await until(() => f.state.calls.some(call => call[0] === 'connect-port'));
  await client.stop();
  await connecting;
  gate.resolve();
  await until(() => raw.destroyed);
  await f.adapters.shutdown();
});

test('a deadline bounds an SDK connect ignoring cancellation and uses an independent cleanup deadline', async () => {
  const gate = deferred();
  const f = fixture({ hostConnectGate: gate.promise, timeoutMs: 15 });
  const host = f.adapters.createHost({ port: PORT, incoming() {} });
  await assert.rejects(host.start(), /timed out/);
  assert.deepEqual(f.state.deleted, ['test-tunnel']);
  assert.equal(f.state.calls.find(call => call[0] === 'delete')[2], false);
  gate.resolve();
  await until(() => f.state.hostDisposals === 2);
  await f.adapters.shutdown();
});

test('late client connection receives another disposal and failed disposal stays retryable', async () => {
  const gate = deferred();
  const f = fixture({ clientConnectGate: gate.promise });
  const client = f.adapters.createClient();
  const connecting = assert.rejects(client.connect(descriptor()), /cancelled/);
  await until(() => f.state.calls.some(call => call[0] === 'client-connect'));
  await client.stop();
  await connecting;
  gate.resolve();
  await until(() => f.state.clientDisposals === 2);
  await f.adapters.shutdown();
  const retry = fixture({ stream: async () => new PassThrough(), clientDisposeFailures: 1 });
  const rejected = retry.adapters.createClient();
  await assert.rejects(rejected.connect(descriptor()), error => !/secret/.test(error.message));
  await rejected.stop();
  assert.equal(retry.state.clientDisposals, 2);
  await retry.adapters.shutdown();
});

test('SDK diagnostic strings never reach safe failure output', () => {
  const message = safeFailure('Relay operation', { response: { status: 401, data: 'secret-body' },
    message: 'secret-token', stack: 'secret-stack', config: { headers: { authorization: 'secret-header' } } });
  assert.match(message, /HTTP 401/);
  assert.doesNotMatch(message, /secret/);
  assert.equal(CancellationToken.None.isCancellationRequested, false);
});
