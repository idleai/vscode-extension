import { DevTunnelsError, RelayHostOptions, RelayJournal, validateMarker } from './contracts';
import { CancellationTokenSource } from 'vscode-jsonrpc';
import { RelayCleanup } from './cleanup';
import { RelayClient } from './client';
import { RelayHost } from './host';
import { defaultSdk, DevTunnelsSdk } from './sdk';
import { bounded, ensureActive, safeFailure } from './security';

export { DevTunnelsError } from './contracts';
export type { HostLease, RelayDescriptor, RelayEndpoint, RelayHostOptions, RelayJournal, RelayStatus } from './contracts';
export { RelayClient } from './client';
export { RelayHost } from './host';
export type { DevTunnelsSdk } from './sdk';

export interface DevTunnelsOptions {
  githubToken(): Promise<string>;
  journal: RelayJournal;
  sdk?: DevTunnelsSdk;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
}

/** Construction is inert. Only explicitly requested operations access the network or credentials. */
export class DevTunnelsAdapters {
  private readonly sdk: DevTunnelsSdk;
  private readonly timeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly hosts = new Set<RelayHost>();
  private readonly clients = new Set<RelayClient>();
  private readonly cleanups = new Map<string, RelayCleanup>();
  private readonly cancellation = new CancellationTokenSource();
  private closed = false;
  private shuttingDown?: Promise<void>;

  constructor(private readonly options: DevTunnelsOptions) {
    this.sdk = options.sdk ?? defaultSdk;
    this.timeoutMs = deadline(options.timeoutMs ?? 60_000);
    this.cleanupTimeoutMs = deadline(options.cleanupTimeoutMs ?? 15_000);
    void this.cancellation.token;
  }

  createHost(options: RelayHostOptions): RelayHost {
    this.ensureOpen();
    const host = new RelayHost(this.sdk, this.options.githubToken, this.options.journal,
      { ...options }, this.timeoutMs, this.cleanupTimeoutMs,
      () => { if (host.retired) this.hosts.delete(host); else this.hosts.add(host); });
    this.hosts.add(host);
    return host;
  }

  createClient(): RelayClient {
    this.ensureOpen();
    const client = new RelayClient(this.sdk, this.timeoutMs, this.cleanupTimeoutMs,
      () => { if (client.retired) this.clients.delete(client); else this.clients.add(client); });
    this.clients.add(client);
    return client;
  }

  /** Claim durable ownership before inspecting service labels or deleting a saved resource. */
  async cleanup(marker: string): Promise<void> {
    this.ensureOpen();
    validateMarker(marker);
    try {
      let cleanup = this.cleanups.get(marker);
      if (!cleanup) {
        await bounded(async token => {
          await this.options.journal.remember(marker);
          ensureActive(token);
        }, this.cancellation.token, this.cleanupTimeoutMs);
        this.ensureOpen();
        cleanup = this.cleanups.get(marker);
        if (!cleanup) {
          cleanup = new RelayCleanup(this.sdk, this.options.githubToken, this.options.journal, marker, this.cleanupTimeoutMs);
          this.cleanups.set(marker, cleanup);
        }
      }
      await cleanup.run();
      this.cleanups.delete(marker);
    } catch (error) { throw new DevTunnelsError(safeFailure('Cleaning saved relay', error)); }
  }

  /** Suspend completed hosts for reload, delete incomplete new hosts, and stop every client. */
  shutdown(): Promise<void> {
    this.closed = true;
    try { this.cancellation.cancel(); } catch { /* Already disposed. */ }
    this.shuttingDown ??= this.close().finally(() => { this.shuttingDown = undefined; });
    return this.shuttingDown;
  }

  private async close(): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.hosts].map(host => host.suspend()),
      ...[...this.clients].map(client => client.stop()),
      ...[...this.cleanups.values()].map(cleanup => cleanup.run()),
    ]);
    if (results.some(result => result.status === 'rejected')) {
      throw new DevTunnelsError('Some relay connections or resources could not be closed; cleanup can be retried.');
    }
    this.cleanups.clear();
    this.cancellation.dispose();
  }

  private ensureOpen(): void {
    if (this.closed) throw new DevTunnelsError('Dev Tunnels adapters have been shut down.');
  }
}

function deadline(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 300_000) throw new DevTunnelsError('Invalid relay deadline.');
  return value;
}
