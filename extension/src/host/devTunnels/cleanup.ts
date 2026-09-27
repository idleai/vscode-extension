import { CancellationToken } from 'vscode-jsonrpc';
import { DevTunnelsError, RelayJournal, validateMarker } from './contracts';
import type { DevTunnelsSdk, Management } from './sdk';
import { bounded, ensureActive, safeFailure } from './security';

/** Resolve service labels before deletion. Saved locators alone never authorize removal. */
async function removeResource(management: Management, journal: RelayJournal, marker: string,
  timeoutMs: number, allowMissing: () => boolean): Promise<void> {
  await bounded(async token => {
    const candidates = await management.listTunnels(undefined, undefined, { labels: [marker], requireAllLabels: true }, token);
    ensureActive(token);
    const matches = candidates.filter(tunnel => tunnel.labels?.includes(marker));
    if (matches.length > 1) throw new DevTunnelsError('Ambiguous relay cleanup record.');
    const tunnel = matches[0];
    if (tunnel) {
      if (!tunnel.tunnelId || !tunnel.clusterId) throw new DevTunnelsError('Missing relay cleanup locator.');
      await management.deleteTunnel({ tunnelId: tunnel.tunnelId, clusterId: tunnel.clusterId }, undefined, token);
      ensureActive(token);
    } else if (!allowMissing()) {
      throw new DevTunnelsError('Creation outcome is uncertain; retry cleanup shortly.');
    }
    await journal.forget(marker);
  }, CancellationToken.None, timeoutMs);
}

/** Retain failed disposal for retry without deleting an already removed resource twice. */
export class RelayCleanup {
  private management?: Management;
  private removed = false;
  private disposed = false;
  private running?: Promise<void>;

  constructor(private readonly sdk: DevTunnelsSdk, private readonly githubToken: () => Promise<string>,
    private readonly journal: RelayJournal, private readonly marker: string, private readonly timeoutMs: number,
    private readonly allowMissing: () => boolean = () => true) { validateMarker(marker); }

  get complete(): boolean { return this.disposed; }

  run(): Promise<void> {
    this.running ??= this.perform().catch(error => { this.running = undefined; throw error; });
    return this.running;
  }

  private async perform(): Promise<void> {
    if (this.disposed) return;
    let failure: string | undefined;
    try {
      this.management ??= this.sdk.createManagement(this.githubToken);
      if (!this.removed) {
        await removeResource(this.management, this.journal, this.marker, this.timeoutMs, this.allowMissing);
        this.removed = true;
      }
    } catch (error) { failure = safeFailure('Relay resource cleanup', error); }
    if (this.management) {
      try {
        await bounded(() => this.management!.dispose(), CancellationToken.None, this.timeoutMs);
        this.management = undefined;
        this.disposed = this.removed;
      } catch { failure = `${failure ? `${failure} ` : ''}Closing relay cleanup management failed.`; }
    }
    if (failure) throw new DevTunnelsError(failure);
  }
}
