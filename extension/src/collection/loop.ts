export interface Update { changed: boolean; pending: boolean; written: number; duplicates: number; conflicts: number; source_bytes: number }
export interface CollectorActions {
  poll(signal: AbortSignal): Promise<Update>;
  observe(signal: AbortSignal): Promise<Update>;
  changed(): void;
  failed(error: unknown): void;
}

/** The platform owns timers and cancellation; the native collector owns source state. */
export class CollectorLoop {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private initial = true;

  constructor(private readonly actions: CollectorActions, private readonly intervalMs = 1000) {}

  wake(): void {
    if (this.abort.signal.aborted || this.running) return;
    clearTimeout(this.timer);
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (!this.abort.signal.aborted) {
        this.timer = setTimeout(() => this.wake(), this.intervalMs);
        this.timer.unref();
      }
    });
  }

  /** Run one pass directly for lifecycle checks and deterministic tests. */
  async flush(): Promise<void> {
    this.wake();
    await this.running;
  }

  private async run(): Promise<void> {
    try {
      let more = true;
      while (more && !this.abort.signal.aborted) {
        const update = await this.actions.poll(this.abort.signal);
        if (this.abort.signal.aborted) return;
        if (update.changed || this.initial) { this.actions.changed(); this.initial = false; }
        more = update.pending;
      }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.actions.failed(error);
      // Imported work can fail independently of an editor or peer append.
      try {
        const update = await this.actions.observe(this.abort.signal);
        if (!this.abort.signal.aborted && update.changed) this.actions.changed();
      } catch { /* The next pass retries; no source checkpoint is advanced here. */ }
    }
  }

  stop(): void { this.abort.abort(); clearTimeout(this.timer); }
  async stopped(): Promise<void> { this.stop(); await this.running; }
}
