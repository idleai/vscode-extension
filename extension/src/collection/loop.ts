import { Sources } from './sources';

export interface Update { changed: boolean; pending: boolean; written: number; duplicates: number; conflicts: number; source_bytes: number }
export interface CollectorActions {
  capture(): Promise<Sources>;
  select(files: string[]): Promise<string[]>;
  poll(paths: string[], gitChanged: boolean, signal: AbortSignal): Promise<Update>;
  changed(): void;
  failed(error: unknown): void;
}

/** Source stamps advance only after every bounded native transaction succeeds. */
export class CollectorLoop {
  private accepted = new Map<string, string>();
  private titles: string | undefined;
  private git: string | undefined;
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
      const source = await this.actions.capture();
      if (this.abort.signal.aborted) return;
      const pending = [...source.files].filter(([file, stamp]) =>
        this.titles !== source.titles || this.accepted.get(file) !== stamp).map(([file]) => file).slice(0, 32);
      const selected = await this.actions.select(pending);
      if (this.abort.signal.aborted) return;
      let more = true;
      let gitChanged = this.git !== source.git;
      while (more && !this.abort.signal.aborted) {
        const update = await this.actions.poll(selected, gitChanged, this.abort.signal);
        if (this.abort.signal.aborted) return;
        if (update.changed || this.initial) { this.actions.changed(); this.initial = false; }
        more = update.pending;
        gitChanged = false;
      }
      if (this.abort.signal.aborted) return;
      this.accepted = this.titles !== source.titles ? new Map() :
        new Map([...this.accepted].filter(([file]) => source.files.has(file)));
      for (const file of pending) this.accepted.set(file, source.files.get(file)!);
      this.titles = source.titles;
      this.git = source.git;
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.actions.failed(error);
      // Imported work can fail independently of an editor or peer append.
      try {
        const update = await this.actions.poll([], false, this.abort.signal);
        if (!this.abort.signal.aborted && update.changed) this.actions.changed();
      } catch { /* The next pass retries; no source checkpoint is advanced here. */ }
    }
  }

  stop(): void { this.abort.abort(); clearTimeout(this.timer); }
  async stopped(): Promise<void> { this.stop(); await this.running; }
}
