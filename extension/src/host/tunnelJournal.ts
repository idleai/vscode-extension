import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";
import { HostError, record } from "./protocol";

interface Lease { owner: string; process: number; leaseUntil: number }
const LEASE_MS = 90_000;

/** VS Code resource journal adapted from the original multiplayer commands.
 * These leases protect local cleanup; they are not domain/controller ownership.
 */
export class TunnelJournal {
  private readonly owner = randomUUID();
  private readonly owned = new Set<string>();
  private tail = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly prefix: string;

  constructor(private readonly state: vscode.Memento, accountId: string,
    private readonly now: () => number = Date.now,
    private readonly alive: (pid: number) => boolean = processAlive) {
    this.prefix = `idle.devTunnels.pending.${encodeURIComponent(accountId)}.`;
  }

  remember(marker: string): Promise<void> {
    return this.serial(async () => {
      if (this.closed) throw new HostError("host_closed", "The tunnel journal is closed.");
      this.validate(marker);
      const key = this.prefix + marker;
      const current = this.state.get<unknown>(key);
      if (this.live(current) && current.owner !== this.owner) {
        throw new HostError("resource_busy", "This Dev Tunnel is active in another window.");
      }
      await this.state.update(key, this.lease());
      this.owned.add(marker);
      this.timer ??= setInterval(() => { void this.renew().catch(() => {}); }, 30_000);
      this.timer.unref();
    });
  }

  forget(marker: string): Promise<void> {
    return this.serial(async () => {
      this.validate(marker);
      const key = this.prefix + marker;
      const current = this.state.get<Lease>(key);
      if (current && current.owner !== this.owner) throw new HostError("resource_busy", "The Dev Tunnel cleanup owner changed.");
      await this.state.update(key, undefined);
      this.owned.delete(marker);
      if (!this.owned.size) { clearInterval(this.timer); this.timer = undefined; }
    });
  }

  /** Cleanup never selects a live host, including one owned by this window. */
  inactiveMarkers(): string[] {
    return this.state.keys().filter(key => key.startsWith(this.prefix) && !this.live(this.state.get(key)))
      .map(key => key.slice(this.prefix.length));
  }

  /** Retain an untransferred marker while making a failed handoff retryable. */
  releaseMarker(marker: string): Promise<void> {
    return this.serial(async () => {
      this.validate(marker);
      const key = this.prefix + marker;
      const current = this.state.get<Lease>(key);
      if (current?.owner === this.owner) await this.state.update(key, { ...current, leaseUntil: 0 });
      this.owned.delete(marker);
      if (!this.owned.size) { clearInterval(this.timer); this.timer = undefined; }
    });
  }

  async release(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.serial(async () => {
      for (const marker of this.owned) {
        const key = this.prefix + marker;
        const current = this.state.get<Lease>(key);
        if (current?.owner === this.owner) await this.state.update(key, { ...current, leaseUntil: 0 });
      }
      this.owned.clear();
    });
  }

  private renew(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      for (const marker of this.owned) {
        const key = this.prefix + marker;
        if (this.state.get<Lease>(key)?.owner === this.owner) await this.state.update(key, this.lease());
      }
    });
  }

  private lease(): Lease { return { owner: this.owner, process: process.pid, leaseUntil: this.now() + LEASE_MS }; }

  private live(value: unknown): value is Lease {
    return record(value) && typeof value.owner === "string" && typeof value.process === "number" &&
      Number.isSafeInteger(value.process) && value.process > 0 && typeof value.leaseUntil === "number" &&
      value.leaseUntil > this.now() && this.alive(value.process);
  }

  private validate(marker: string): void {
    if (!/^idle-relay-[a-f0-9]{24}$/.test(marker)) throw new HostError("invalid_request", "Invalid tunnel cleanup marker.");
  }

  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => {});
    return next;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(record(error) && error.code === "ESRCH"); }
}
