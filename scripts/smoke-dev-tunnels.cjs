'use strict';

// Explicit, authenticated cloud test. Never include descriptors, SDK errors or tokens in output.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CancellationToken, CancellationTokenSource } = require('vscode-jsonrpc');
const { TunnelAccessControlEntryType } = require('@microsoft/dev-tunnels-contracts');
const { SecureStream } = require('@microsoft/dev-tunnels-ssh');
const { DevTunnelsAdapters, DevTunnelsError } = require('../out/host/devTunnels');
const { validateMarker } = require('../out/host/devTunnels/contracts');
const { defaultSdk, managementClient } = require('../out/host/devTunnels/sdk');
const { bounded, ensureActive, safeFailure } = require('../out/host/devTunnels/security');
const { writeTransport } = require('../out/host/transport');

const PORT = 43188;
const TIMEOUT = 45_000;
const CLEANUP_TIMEOUT = 20_000;
const PAYLOAD_BYTES = 1024 * 1024;

function check(condition, message) {
  if (!condition) throw new DevTunnelsError(message);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Keep every marker until independent service verification, even after journal.forget(). */
class ProbeJournal {
  constructor(file, markers = [], pending = markers) {
    this.file = file;
    this.markers = new Set(markers);
    this.pending = new Set(pending);
  }

  static create() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-tunnel-probe-'));
    const journal = new ProbeJournal(path.join(directory, 'cleanup.json'));
    journal.persist();
    return journal;
  }

  static load(file) {
    check(fs.statSync(file).size <= 16_384, 'Invalid probe cleanup journal.');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(record.version === 1 && Array.isArray(record.markers) && Array.isArray(record.pending),
      'Invalid probe cleanup journal.');
    for (const marker of [...record.markers, ...record.pending]) validateMarker(marker);
    check(record.pending.every(marker => record.markers.includes(marker)), 'Invalid probe cleanup journal.');
    return new ProbeJournal(path.resolve(file), record.markers, record.pending);
  }

  persist() {
    const next = `${this.file}.next`;
    const fd = fs.openSync(next, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, markers: [...this.markers], pending: [...this.pending] }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(next, this.file);
    // Flush the rename on platforms that support directory fsync.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }

  async remember(marker) {
    validateMarker(marker);
    this.markers.add(marker);
    this.pending.add(marker);
    this.persist();
  }

  async forget(marker) {
    this.pending.delete(marker);
    this.persist();
  }

  remove() {
    fs.unlinkSync(this.file);
    // Never recursively delete a directory supplied to --cleanup.
    try { fs.rmdirSync(path.dirname(this.file)); } catch { /* Other files may remain. */ }
  }
}

function receive(stream, expected, token) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    let subscription;
    const finish = error => {
      stream.pause();
      stream.off('data', data); stream.off('close', closed); stream.off('end', closed); stream.off('error', failed);
      subscription?.dispose();
      if (error) reject(error); else resolve();
    };
    const failed = () => finish(new DevTunnelsError('Synthetic byte transfer failed.'));
    const closed = () => finish(new DevTunnelsError('Relay closed before all synthetic bytes arrived.'));
    const data = chunk => {
      if (!Buffer.isBuffer(chunk) || offset + chunk.length > expected.length ||
        !chunk.equals(expected.subarray(offset, offset + chunk.length))) { failed(); return; }
      offset += chunk.length;
      if (offset === expected.length) finish();
    };
    stream.on('data', data); stream.once('close', closed); stream.once('end', closed); stream.once('error', failed);
    subscription = token.onCancellationRequested(failed);
    if (token.isCancellationRequested) failed(); else stream.resume();
  });
}

async function exchange(host, client, cancellation, timeout = TIMEOUT) {
  const fromHost = Buffer.alloc(PAYLOAD_BYTES, 0xa5);
  const fromClient = Buffer.alloc(PAYLOAD_BYTES, 0x5a);
  try {
    await bounded(token => Promise.all([
      receive(host, fromClient, token), receive(client, fromHost, token),
      writeTransport(host, fromHost), writeTransport(client, fromClient),
    ]), cancellation, timeout);
  } catch (error) { host.destroy(); client.destroy(); throw error; }
}

function closed(stream, token) {
  if (stream.closed || stream.readableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let subscription;
    const finish = error => {
      stream.pause();
      stream.off('close', done); stream.off('end', done);
      subscription?.dispose();
      if (error) reject(error); else resolve();
    };
    const done = () => finish();
    stream.once('close', done); stream.once('end', done);
    subscription = token.onCancellationRequested(() => finish(new DevTunnelsError('Peer did not observe host suspension.')));
    if (token.isCancellationRequested) finish(new DevTunnelsError('Operation cancelled or timed out.'));
    else stream.resume();
  });
}

async function runProbe(adapters, management, journal, hosts, clients, waitingForPort, cancellation, progress) {
  const start = async lease => {
    const incoming = deferred();
    const host = adapters.createHost({ port: PORT, incoming: incoming.resolve });
    hosts.push(host);
    await host.start(lease, cancellation);
    return { host, incoming };
  };
  const connect = async (owner, descriptor) => {
    const client = adapters.createClient();
    clients.push(client);
    const [remote, local] = await Promise.all([
      bounded(() => owner.incoming.promise, cancellation, TIMEOUT), client.connect(descriptor, cancellation),
    ]);
    return { client, remote, local };
  };

  progress('creating a private relay');
  const first = await start();
  const lease = first.host.lease();
  const resource = await bounded(token => management.getTunnel(lease, { includePorts: true }, token), cancellation, TIMEOUT);
  check(resource && resource.labels?.includes(lease.marker), 'The live resource lacks its cleanup marker.');
  const access = [resource, ...(resource.ports ?? [])].flatMap(value => value.accessControl?.entries ?? []);
  check(!access.some(entry => entry.type === TunnelAccessControlEntryType.Anonymous && !entry.isDeny),
    'The live resource unexpectedly permits anonymous access.');
  const original = await first.host.descriptor();
  const pair = await connect(first, original);
  await exchange(pair.remote, pair.local, cancellation);
  console.log(`PASS: authenticated encrypted ${pair.local instanceof SecureStream ? 'V2' : 'V1'} relay; 1 MiB verified in each direction.`);

  progress('suspending the host and observing peer disconnection');
  await bounded(async token => {
    const disconnected = closed(pair.local, token);
    await Promise.all([disconnected, first.host.suspend()]);
  }, cancellation, TIMEOUT);
  await pair.client.stop();
  check(journal.pending.has(lease.marker), 'Suspension lost the durable lease.');
  console.log('PASS: host suspension closes the peer stream and retains the lease.');

  progress('resuming the lease with a new host identity');
  const resumed = await start(lease);
  const renewed = await resumed.host.descriptor();
  check(resumed.host.lease().tunnelId === lease.tunnelId, 'Resume created a different cloud resource.');
  check(JSON.stringify(renewed.endpoint.hostPublicKeys) !== JSON.stringify(original.endpoint.hostPublicKeys),
    'The resumed host unexpectedly reused its previous identity.');
  const reconnected = await connect(resumed, renewed);
  await exchange(reconnected.remote, reconnected.local, cancellation);
  const unapproved = adapters.createClient();
  clients.push(unapproved);
  let refused = false;
  try {
    await unapproved.connect({ ...renewed, endpoint: { ...renewed.endpoint, hostPublicKeys: original.endpoint.hostPublicKeys } }, cancellation);
  } catch (error) {
    ensureActive(cancellation);
    check(error instanceof DevTunnelsError, 'Unexpected host identity check failure.');
    check(!/timed out|cancelled/.test(error.message), 'The host identity check timed out instead of rejecting the key.');
    refused = true;
  } finally { await unapproved.stop(); }
  check(refused, 'A client accepted an unapproved host identity.');
  console.log('PASS: old host key refused; approved reconnect verified 1 MiB in each direction.');

  progress('cancelling a live wait for an unpublished port');
  const cancelled = adapters.createClient();
  clients.push(cancelled);
  const source = new CancellationTokenSource();
  const pending = cancelled.connect({ ...renewed, port: PORT + 1 }, source.token)
    .then(stream => { stream.destroy(); return { connected: true }; }, error => ({ error }));
  try {
    await bounded(async token => {
      const ready = await Promise.race([waitingForPort.promise.then(() => true), pending.then(() => false)]);
      ensureActive(token);
      check(ready, 'The cancellation probe did not reach the live forwarded-port wait.');
      source.cancel();
      const result = await pending;
      check(result.error instanceof DevTunnelsError && /cancelled|timed out/.test(result.error.message),
        'The live operation did not report cancellation.');
    }, cancellation, TIMEOUT);
  } finally { source.cancel(); source.dispose(); await cancelled.stop(); }
  console.log('PASS: live cancellation completed and disposed the client.');
}

async function cleanup(adapters, management, journal, hosts, clients, recovery) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const stopped = await Promise.allSettled([
        ...clients.map(client => client.stop()), ...[...hosts].reverse().map(host => host.stop()),
      ]);
      // Recovery is only for a previous process; live hosts own uncertain late creates.
      if (recovery) for (const marker of journal.markers) await adapters.cleanup(marker);
      check(stopped.every(result => result.status === 'fulfilled'), 'Some relay adapters could not close; cleanup will be retried.');
      check(hosts.every(host => host.retired) && clients.every(client => client.retired),
        'Relay operations are still settling; the cleanup journal was retained.');
      for (const marker of journal.markers) {
        const remaining = await bounded(token => management.listTunnels(undefined, undefined,
          { labels: [marker], requireAllLabels: true }, token), CancellationToken.None, CLEANUP_TIMEOUT);
        check(!remaining.some(tunnel => tunnel.labels?.includes(marker)), 'The service still lists the temporary relay.');
      }
      check(journal.pending.size === 0, 'Cleanup left a pending journal marker.');
      await adapters.shutdown();
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function main(args) {
  check(args.length === 0 || (args.length === 2 && args[0] === '--cleanup'),
    'Usage: node scripts/smoke-dev-tunnels.cjs [--cleanup /path/to/cleanup.json]');
  let token;
  try {
    token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }).trim();
  } catch { throw new DevTunnelsError('A current gh auth login for github.com is required.'); }
  check(token.length > 0, 'GitHub CLI returned no credential.');
  const githubToken = async () => token;
  const recovery = args.length > 0;
  const journal = recovery ? ProbeJournal.load(args[1]) : ProbeJournal.create();
  console.log(`Cleanup journal (no tokens): ${journal.file}`);
  const waitingForPort = deferred();
  // Observe a real SDK wait so cancellation happens after the live relay connects.
  const sdk = { ...defaultSdk, createClient() {
    const client = defaultSdk.createClient();
    const wait = client.waitForForwardedPort.bind(client);
    client.waitForForwardedPort = (port, cancellation) => {
      if (port === PORT + 1) waitingForPort.resolve();
      return wait(port, cancellation);
    };
    return client;
  } };
  const adapters = new DevTunnelsAdapters({ githubToken, journal, sdk, timeoutMs: TIMEOUT, cleanupTimeoutMs: CLEANUP_TIMEOUT });
  const management = managementClient(githubToken);
  const cancellation = new CancellationTokenSource();
  const interrupt = () => cancellation.cancel();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const hosts = [], clients = [];
  let stage = 'starting';
  let failure;
  let removed = false;
  const progress = value => { stage = value; console.log(`Running: ${stage}.`); };
  try {
    if (!recovery) await runProbe(adapters, management, journal, hosts, clients, waitingForPort, cancellation.token, progress);
  } catch (error) { failure = safeFailure(stage, error); }
  finally {
    console.log('Running: deleting the temporary relay and verifying its absence.');
    try {
      await cleanup(adapters, management, journal, hosts, clients, recovery);
      removed = true;
      console.log('PASS: service lists no matching tunnels; all adapters and journal leases closed.');
    } catch (error) { failure = `${failure ? `${failure} ` : ''}${safeFailure('Cleanup', error)}`; }
    try { await bounded(() => management.dispose(), CancellationToken.None, CLEANUP_TIMEOUT); }
    catch { failure = `${failure ? `${failure} ` : ''}Closing verification management failed.`; }
    token = '';
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    cancellation.dispose();
    if (removed) journal.remove();
    else console.error(`Cleanup journal retained. After this process exits, rerun with --cleanup ${journal.file}`);
  }
  if (failure) throw new DevTunnelsError(failure);
  console.log(recovery ? 'PASS: saved probe cleanup verified.' : 'PASS: same-machine live Dev Tunnels verification.');
}

module.exports = { ProbeJournal, exchange };
if (require.main === module) {
  void main(process.argv.slice(2)).catch(error => {
    console.error(safeFailure('Live tunnel probe', error));
    process.exitCode = 1;
  });
}
