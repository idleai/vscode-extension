import type { Duplex } from 'node:stream';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import type { ForwardedPortConnectingEventArgs } from '@microsoft/dev-tunnels-ssh-tcp';
import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc';
import { DevTunnelsError, RelayDescriptor, descriptorTunnel } from './contracts';
import type { DevTunnelsSdk, SdkClient } from './sdk';
import { bounded, closeRelayStream, encryptedStream, encryptedV1SessionId, ensureActive, rejectForwardedStream, safeFailure } from './security';

export class RelayClient {
  private readonly cancellation = new CancellationTokenSource();
  private readonly streams = new Set<Duplex>();
  private readonly verified = new WeakSet<Duplex>();
  private client?: SdkClient;
  private subscription?: { dispose(): void };
  private closed = false;
  private started = false;
  private disposed = false;
  private workPending = false;
  private transformsPending = 0;
  private stopping?: Promise<void>;

  constructor(private readonly sdk: DevTunnelsSdk, private readonly timeoutMs: number, private readonly cleanupTimeoutMs: number,
    private readonly changed: () => void = () => {}) {
    void this.cancellation.token;
  }

  get retired(): boolean {
    return this.closed && !this.workPending && !this.transformsPending && (!this.client || this.disposed);
  }

  async connect(descriptor: RelayDescriptor, cancellation = CancellationToken.None): Promise<Duplex> {
    if (this.started || this.closed) throw new DevTunnelsError('The relay client has already been started or closed.');
    // Validate and copy all approved endpoint data before constructing any SDK transport.
    const tunnel = descriptorTunnel(descriptor);
    const port = descriptor.port;
    this.started = true;
    const subscription = cancellation.onCancellationRequested(() => this.cancellation.cancel());
    if (cancellation.isCancellationRequested) this.cancellation.cancel();
    try {
      return await bounded(token => this.connectServices(tunnel, port, token), this.cancellation.token, this.timeoutMs);
    } catch (error) {
      const message = safeFailure('Connecting relay client', error);
      try { await this.stop(); }
      catch { throw new DevTunnelsError(`${message} Closing the relay client is pending.`); }
      throw new DevTunnelsError(message);
    } finally { subscription.dispose(); }
  }

  private async connectServices(tunnel: Tunnel, port: number, token: CancellationToken): Promise<Duplex> {
    this.workPending = true;
    this.changed();
    try {
      this.client = this.sdk.createClient();
      this.client.acceptLocalConnectionsForForwardedPorts = false;
      this.client.enableE2EEncryption = true;
      this.subscription = this.client.forwardedPortConnecting(event => this.transform(event, port));
      try { await this.client.connect(tunnel, { enableRetry: false, enableReconnect: false }, token); }
      finally {
        if (this.closed) {
          await this.stopping?.catch(() => {});
          this.disposed = false;
          this.stopping = undefined;
          await this.stop();
        }
      }
      ensureActive(token);
      await this.client.waitForForwardedPort(port, token);
      ensureActive(token);
      const stream = await this.client.connectToForwardedPort(port, token);
      this.track(stream);
      if (token.isCancellationRequested || this.closed || stream.destroyed || stream.writableEnded) {
        closeRelayStream(stream);
        throw new DevTunnelsError('The relay client was closed or cancelled.');
      }
      if (this.client.connectionProtocol === 'tunnel-relay-client') encryptedV1SessionId(stream);
      else if (this.client.connectionProtocol !== 'tunnel-relay-client-v2-dev' || !this.verified.has(stream)) {
        closeRelayStream(stream);
        throw new DevTunnelsError('Unsupported or unencrypted relay stream.');
      }
      stream.pause();
      return stream;
    } finally { this.workPending = false; this.changed(); }
  }

  stop(): Promise<void> {
    this.closed = true;
    this.changed();
    try { this.cancellation.cancel(); } catch { /* Already disposed. */ }
    this.stopping ??= this.close().catch(error => { this.stopping = undefined; throw error; });
    return this.stopping;
  }

  private async close(): Promise<void> {
    this.subscription?.dispose();
    this.subscription = undefined;
    for (const stream of this.streams) closeRelayStream(stream);
    this.streams.clear();
    try {
      if (this.client && !this.disposed) {
        await bounded(() => this.client!.dispose(), CancellationToken.None, this.cleanupTimeoutMs);
        this.disposed = true;
      }
    } catch { throw new DevTunnelsError('Closing the relay client failed.'); }
    finally { this.cancellation.dispose(); this.changed(); }
  }

  private transform(event: ForwardedPortConnectingEventArgs, port: number): void {
    this.track(event.stream);
    if (this.closed || this.client?.connectionProtocol !== 'tunnel-relay-client-v2-dev') {
      rejectForwardedStream(event);
      return;
    }
    const secured = encryptedStream(event, port);
    this.transformsPending++;
    event.transformPromise = secured.then(stream => {
      this.track(stream);
      if (this.closed) { closeRelayStream(stream); return null; }
      this.verified.add(stream);
      return stream;
    });
    void event.transformPromise.catch(() => { event.stream.destroy(); })
      .finally(() => { this.transformsPending--; this.changed(); });
  }

  private track(stream: Duplex): void {
    stream.on('error', () => {});
    this.streams.add(stream);
    stream.once('close', () => this.streams.delete(stream));
  }
}
