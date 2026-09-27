import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { ConnectionStatus } from '@microsoft/dev-tunnels-connections';
import { TunnelAccessScopes, TunnelProtocol } from '@microsoft/dev-tunnels-contracts';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import type { ForwardedPortConnectingEventArgs } from '@microsoft/dev-tunnels-ssh-tcp';
import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc';
import { DevTunnelsError, HostLease, RelayDescriptor, RelayHostOptions, RelayJournal,
  hostDescriptor, validateLease, validatePort } from './contracts';
import { RelayCleanup } from './cleanup';
import type { DevTunnelsSdk, Management, SdkHost } from './sdk';
import { bounded, closeRelayStream, encryptedHostStream, ensureActive, httpStatus, rejectForwardedStream, safeFailure } from './security';

type Connection = { raw: Duplex; stream?: Duplex };

/** Platform lifecycle only. Membership, sharing decisions and reconnect policy belong in Rust. */
export class RelayHost {
  private readonly cancellation = new CancellationTokenSource();
  private marker = `idle-relay-${randomBytes(12).toString('hex')}`;
  private services?: { management: Management; host: SdkHost };
  private tunnel?: Tunnel;
  private started = false;
  private ready = false;
  private resuming = false;
  private closed = false;
  private recorded = false;
  private createAttempted = false;
  private creationRejected = false;
  private removeRequested = false;
  private hostDisposed = false;
  private managementDisposed = false;
  private workPending = false;
  private hostConnectPending = false;
  private transformsPending = 0;
  private closing?: Promise<void>;
  private cleanup?: RelayCleanup;
  private subscriptions: { dispose(): void }[] = [];
  private readonly connections = new Set<Connection>();

  constructor(private readonly sdk: DevTunnelsSdk, private readonly githubToken: () => Promise<string>,
    private readonly journal: RelayJournal, private readonly options: RelayHostOptions,
    private readonly timeoutMs: number, private readonly cleanupTimeoutMs: number,
    private readonly changed: () => void = () => {}) {
    validatePort(options.port);
    void this.cancellation.token;
  }

  /** Operational resources have closed; a caller-held suspended lease may still be stopped. */
  get retired(): boolean {
    return this.closed && !this.workPending && !this.transformsPending &&
      (!this.services || (this.hostDisposed && this.managementDisposed)) &&
      (!this.removeRequested || !this.recorded || this.cleanup?.complete === true);
  }

  async start(previous?: HostLease, cancellation = CancellationToken.None): Promise<void> {
    if (this.started || this.closed) throw new DevTunnelsError('The relay host has already been started or closed.');
    const lease = previous ? validateLease(previous) : undefined;
    this.started = true;
    this.resuming = !!lease;
    if (lease) this.marker = lease.marker;
    const subscription = cancellation.onCancellationRequested(() => this.cancellation.cancel());
    if (cancellation.isCancellationRequested) this.cancellation.cancel();
    try {
      await bounded(token => this.startServices(lease, token), this.cancellation.token, this.timeoutMs);
    } catch (error) {
      const message = safeFailure('Starting relay host', error);
      try { await (lease && !this.removeRequested ? this.suspend() : this.stop()); }
      catch { throw new DevTunnelsError(`${message} Relay cleanup is pending.`); }
      throw new DevTunnelsError(message);
    } finally { subscription.dispose(); }
  }

  private async startServices(previous: HostLease | undefined, token: CancellationToken): Promise<void> {
    this.workPending = true;
    this.changed();
    try {
      await this.journal.remember(this.marker);
      this.recorded = true;
      ensureActive(token);
      this.services = this.sdk.createHost(this.githubToken);
      const { management, host } = this.services;
      host.forwardConnectionsToLocalPorts = false;
      host.enableE2EEncryption = true;
      this.tunnel = await this.acquireTunnel(management, previous, token);
      ensureActive(token);
      this.subscribe(host);
      // The shared runtime decides when to reconnect and whether renewed access is allowed.
      this.hostConnectPending = true;
      try { await host.connect(this.tunnel, { enableRetry: false, enableReconnect: false }, token); }
      finally {
        this.hostConnectPending = false;
        if (this.closed) {
          await this.closing?.catch(() => {});
          this.hostDisposed = false;
          this.closing = undefined;
        }
      }
      ensureActive(token);
      this.ready = true;
    } finally {
      // An SDK create or journal write may settle after the caller's deadline and teardown.
      // Re-run cleanup with the newly known result; never resume hosting after cancellation.
      if (this.closed) {
        try { await this.retire(this.removeRequested); }
        catch { this.reportFailure('Relay cleanup is pending; retry cleanup from the host.'); }
      }
      this.workPending = false;
      this.changed();
    }
  }

  private async acquireTunnel(management: Management, previous: HostLease | undefined, token: CancellationToken): Promise<Tunnel> {
    if (previous) {
      const tunnel = await management.getTunnel(previous, { includePorts: true, tokenScopes: [TunnelAccessScopes.Host] }, token);
      if (!tunnel || tunnel.tunnelId !== previous.tunnelId || tunnel.clusterId !== previous.clusterId ||
        !tunnel.labels?.includes(this.marker)) throw new DevTunnelsError('The saved relay resource is unavailable.');
      return tunnel;
    }
    this.createAttempted = true;
    try {
      // Let the service allocate an ID: a tunnel name is a custom DNS alias, not a label.
      return await management.createTunnel({ labels: ['idle-relay', this.marker], customExpiration: 86400,
        ports: [{ portNumber: this.options.port, protocol: TunnelProtocol.Auto }] },
      { tokenScopes: [TunnelAccessScopes.Host] }, token);
    } catch (error) {
      this.creationRejected = [400, 403].includes(httpStatus(error) ?? 0);
      throw error;
    }
  }

  lease(): HostLease {
    return validateLease({ marker: this.marker, tunnelId: this.tunnel?.tunnelId!, clusterId: this.tunnel?.clusterId! });
  }

  async descriptor(): Promise<RelayDescriptor> {
    if (this.closed || !this.ready || !this.services || !this.tunnel) throw new DevTunnelsError('The relay host is not running.');
    try {
      return await bounded(async token => {
        const tunnel = await this.services!.management.getTunnel(this.tunnel!,
          { includePorts: true, tokenScopes: [TunnelAccessScopes.Connect] }, token);
        ensureActive(token);
        if (tunnel?.tunnelId !== this.tunnel!.tunnelId || tunnel?.clusterId !== this.tunnel!.clusterId) {
          throw new DevTunnelsError('The relay service returned a different resource.');
        }
        return hostDescriptor(tunnel, this.services!.host.hostPublicKeys, this.options.port);
      }, this.cancellation.token, this.timeoutMs);
    } catch (error) { throw new DevTunnelsError(safeFailure('Resolving relay endpoint', error)); }
  }

  /** Remove the cloud resource and its journal entry. Failures remain retryable. */
  stop(): Promise<void> { return this.retire(true); }

  /** Preserve a running or resumed lease across reload; incomplete new hosting is removed. */
  suspend(): Promise<void> { return this.retire(!this.ready && !this.resuming); }

  private async retire(remove: boolean): Promise<void> {
    this.closed = true;
    this.removeRequested ||= remove;
    this.changed();
    try { this.cancellation.cancel(); } catch { /* An already disposed source is cancelled. */ }
    const failures: string[] = [];
    try { await (this.closing ??= this.closeServices().catch(error => { this.closing = undefined; throw error; })); }
    catch (error) { failures.push(safeFailure('Closing relay host', error)); }
    if (this.removeRequested && this.recorded) {
      this.cleanup ??= new RelayCleanup(this.sdk, this.githubToken, this.journal, this.marker, this.cleanupTimeoutMs,
        () => !this.createAttempted || !!this.tunnel || this.creationRejected);
      try { await this.cleanup.run(); }
      catch (error) { failures.push(safeFailure('Removing relay resource', error)); }
    }
    this.changed();
    if (failures.length) throw new DevTunnelsError(failures.join(' '));
  }

  private async closeServices(): Promise<void> {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    for (const connection of this.connections) {
      if (connection.stream) closeRelayStream(connection.stream);
      connection.raw.destroy();
    }
    this.connections.clear();
    const failures: string[] = [];
    if (this.services && !this.hostDisposed) {
      try { await bounded(() => this.services!.host.dispose(), CancellationToken.None, this.cleanupTimeoutMs); this.hostDisposed = true; }
      catch { failures.push('Closing the relay connection failed.'); }
    }
    if (this.services && this.hostDisposed && !this.hostConnectPending && !this.managementDisposed) {
      try { await bounded(() => this.services!.management.dispose(), CancellationToken.None, this.cleanupTimeoutMs); this.managementDisposed = true; }
      catch { failures.push('Closing relay management failed.'); }
    }
    this.cancellation.dispose();
    if (failures.length) throw new DevTunnelsError(failures.join(' '));
  }

  private subscribe(host: SdkHost): void {
    this.subscriptions.push(host.forwardedPortConnecting(event => this.accept(event, host.connectionProtocol)));
    this.subscriptions.push(host.connectionStatusChanged(event => {
      if (this.closed) return;
      const status = event.status === ConnectionStatus.Connecting ? 'connecting' :
        event.status === ConnectionStatus.Connected ? 'connected' :
          event.status === ConnectionStatus.Disconnected ? 'disconnected' : undefined;
      if (status) {
        try { this.options.onStatus?.(status); } catch { /* Caller diagnostics cannot interrupt SDK teardown. */ }
      }
    }));
  }

  private accept(event: ForwardedPortConnectingEventArgs, protocol: string | undefined): void {
    event.stream.on('error', () => {});
    if (this.closed || this.connections.size >= 8) { rejectForwardedStream(event); return; }
    const connection: Connection = { raw: event.stream };
    this.connections.add(connection);
    event.stream.once('close', () => this.connections.delete(connection));
    const secured = encryptedHostStream(event, protocol, this.options.port);
    this.transformsPending++;
    event.transformPromise = secured.then(stream => {
      stream.on('error', () => {});
      if (this.closed) { closeRelayStream(stream); return null; }
      if (stream.destroyed || stream.writableEnded) throw new DevTunnelsError('The incoming relay stream has already closed.');
      connection.stream = stream;
      stream.once('close', () => this.connections.delete(connection));
      stream.pause();
      try { this.options.incoming(stream); }
      catch { stream.destroy(); throw new DevTunnelsError('The incoming relay stream could not be accepted.'); }
      return stream;
    });
    void event.transformPromise.catch(() => {
      connection.raw.destroy();
      this.connections.delete(connection);
      this.reportFailure('An incoming relay stream failed encryption or acceptance checks.');
    }).finally(() => { this.transformsPending--; this.changed(); });
  }

  private reportFailure(message: string): void {
    try { this.options.onFailure?.(message); } catch { /* Diagnostics are best effort. */ }
  }
}
