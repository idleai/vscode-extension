const assert = require('node:assert/strict');
const test = require('node:test');
const { CancellationToken, CancellationTokenSource } = require('vscode-jsonrpc');
const { refreshEndpoint, relayProvider } = require('../out/sharing/relay');
const { validateLease } = require('@idle/history-runtime/transport');

const endpoint = { tunnelId: 'same-tunnel', clusterId: 'use', hostId: 'old-host', hostPublicKeys: ['b2xk'],
  clientRelayUri: 'wss://use.rel.tunnels.api.visualstudio.com/old' };
const descriptor = { endpoint, connectToken: 'private-connect-grant', port: 43188 };
const renewed = { ...endpoint, hostId: 'new-host', hostPublicKeys: ['bmV3'], clientRelayUri: 'wss://use.rel.tunnels.api.visualstudio.com/new' };
function management(value) {
  const calls = [];
  return { calls, async getTunnel(locator, options, token) {
    calls.push({ locator, options, cancelled: token.isCancellationRequested });
    return typeof value === 'function' ? value() : value;
  }, async dispose() { calls.push('disposed'); } };
}

test('relay refresh keeps the same resource and connect grant while adopting its current transport key', async () => {
  const service = management({ ...renewed, endpoints: [{ ...renewed, connectionMode: 'TunnelRelay' }] });
  const result = await refreshEndpoint(descriptor, CancellationToken.None, service);
  assert.deepEqual(result, { ...descriptor, endpoint: renewed });
  assert.equal(service.calls[0].locator.accessTokens.connect, descriptor.connectToken);
  assert.deepEqual(service.calls[0].options, { includePorts: true });
  assert.equal(service.calls.at(-1), 'disposed');
  assert.deepEqual(descriptor.endpoint, endpoint, 'the saved invitation stays immutable');
});

test('relay refresh rejects another resource, ambiguous hosts and untrusted addresses', async () => {
  for (const value of [
    { ...renewed, tunnelId: 'another-tunnel', endpoints: [{ ...renewed, connectionMode: 'TunnelRelay' }] },
    { ...renewed, endpoints: [1, 2].map(() => ({ ...renewed, connectionMode: 'TunnelRelay' })) },
    { ...renewed, endpoints: [{ ...renewed, connectionMode: 'TunnelRelay', clientRelayUri: 'wss://untrusted.example/' }] },
  ]) {
    const service = management(value);
    await assert.rejects(refreshEndpoint(descriptor, CancellationToken.None, service), /could not be refreshed/);
    assert.equal(service.calls.at(-1), 'disposed');
  }
});

test('cancelled endpoint lookup cannot return keys and service diagnostics remain private', async () => {
  const cancellation = new CancellationTokenSource();
  const service = management(() => {
    cancellation.cancel();
    return { ...renewed, endpoints: [{ ...renewed, connectionMode: 'TunnelRelay' }] };
  });
  try { await assert.rejects(refreshEndpoint(descriptor, cancellation.token, service), /could not be refreshed/); }
  finally { cancellation.dispose(); }
  const failed = management(() => { throw new Error('sensitive cloud response'); });
  await assert.rejects(refreshEndpoint(descriptor, CancellationToken.None, failed), error =>
    error.message === 'The approved relay endpoint could not be refreshed.');
  assert.equal(failed.calls.at(-1), 'disposed');
});

test('the sharing relay uses journal leases and forwards a disconnect to portable recovery', async () => {
  let options;
  const lease = { marker: 'idle-relay-' + 'a'.repeat(24), tunnelId: 'same-tunnel', clusterId: 'use' };
  const calls = [];
  const adapters = {
    createHost(input) {
      options = input;
      return { async start(saved) { calls.push(['start', saved]); }, lease: () => lease,
        async stop() { calls.push('stop'); }, async suspend() { calls.push('suspend'); } };
    },
    async cleanup(marker) { calls.push(['cleanup', marker]); },
  };
  const failed = [], relay = relayProvider(adapters);
  const host = relay.host(() => {}, (...args) => failed.push(args));
  await host.start(lease);
  assert.deepEqual(validateLease(host.lease()), lease, 'the portable coordinator accepts the host journal marker');
  options.onStatus('disconnected');
  assert.deepEqual(failed, [['History relay disconnected.', true]]);
  await host.suspend(); await host.stop(); await relay.remove(lease);
  assert.deepEqual(calls, [['start', lease], 'suspend', 'stop', ['cleanup', lease.marker]]);
});

test('Stop during endpoint lookup prevents a later client connection', async () => {
  let release, token, connected = 0, stopped = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const adapters = { createClient: () => ({ async connect() { connected++; }, async stop() { stopped++; } }) };
  const relay = relayProvider(adapters, async (_input, cancellation) => { token = cancellation; await pending; return descriptor; });
  const client = relay.client();
  const connecting = client.connect({ endpoint, connectToken: descriptor.connectToken });
  await client.stop();
  assert.equal(token.isCancellationRequested, true);
  release();
  await assert.rejects(connecting);
  assert.equal(connected, 0); assert.equal(stopped, 1);
});
