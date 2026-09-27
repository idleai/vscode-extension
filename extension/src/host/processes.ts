import { NativeProcess, NativeProcessOptions, ProcessStartOptions } from './nativeProcess';

export type { NativeProcessOptions, ProcessSpawner, ProcessStartOptions } from './nativeProcess';

export interface RequestOptions {
  /** No deadline by default. Zero also means no deadline for long native work. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface PendingRequest {
  resolve(body: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Native history RPC: a framed JSON {id, body} envelope on the file-owning host. */
export class StdioClient {
  private readonly process: NativeProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private handler?: (message: unknown) => void;
  private log?: (line: string) => void;

  constructor(options: NativeProcessOptions = {}) {
    this.process = new NativeProcess({
      frame: payload => this.receive(payload),
      closed: error => this.rejectPending(error),
      log: line => this.logLine(line),
    }, options);
  }

  /** Opt-in raw service diagnostics; do not forward stderr to untrusted views. */
  setLog(sink: (line: string) => void): void { this.log = sink; }

  setMessageHandler(handler: (message: unknown) => void): void { this.handler = handler; }

  isRunning(): boolean { return this.process.isRunning(); }

  start(binaryPath: string, options?: ProcessStartOptions): void {
    if (this.isRunning()) return;
    this.nextId = 1;
    this.process.start(binaryPath, options);
  }

  ensureStarted(binaryPath: string, options?: ProcessStartOptions): void { this.start(binaryPath, options); }

  request(body: unknown, options?: RequestOptions): Promise<unknown> {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(body); } catch { return Promise.reject(new Error('Native request is not JSON serializable.')); }
    if (serialized === undefined) return Promise.reject(new Error('Native request is not JSON serializable.'));
    return this.send([serialized], options);
  }

  /** Trusted, already serialized JSON: preserve exact UTF-8 bytes without decoding snapshots. */
  requestJson(body: Buffer | readonly Buffer[], options?: RequestOptions): Promise<unknown> {
    return this.send(Buffer.isBuffer(body) ? [body] : body, options);
  }

  stop(): void { this.process.stop(); }

  dispose(): void { this.process.dispose(); }

  shutdown(): Promise<void> { return this.process.shutdown(); }

  private send(parts: readonly (string | Buffer)[], options: RequestOptions = {}): Promise<unknown> {
    if (!this.isRunning()) return Promise.reject(new Error('Native process is not running.'));
    const timeout = options.timeoutMs ?? 0;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 0x7fffffff) {
      return Promise.reject(new Error('Invalid native request timeout.'));
    }
    if (options.signal?.aborted) return Promise.reject(new Error('Native request aborted.'));
    if (!Number.isSafeInteger(this.nextId)) return Promise.reject(new Error('Native request identifiers exhausted.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const abort = () => this.settle(id, pending, new Error('Native request aborted.'));
      const pending: PendingRequest = {
        resolve, reject,
        cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); },
      };
      this.pending.set(id, pending);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (timeout) timer = setTimeout(() => this.settle(id, pending, new Error('Native request timed out.')), timeout);
      void this.process.write([`{"id":${id},"body":`, ...parts, '}'])
        .catch(error => this.settle(id, pending, error instanceof Error ? error : new Error('Native request write failed.')));
    });
  }

  private settle(id: number, pending: PendingRequest, error?: Error, body?: unknown): void {
    // Late write callbacks from an old generation may reuse a new request's id.
    if (this.pending.get(id) !== pending) return;
    this.pending.delete(id);
    pending.cleanup();
    if (error) pending.reject(error); else pending.resolve(body);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) this.settle(id, pending, error);
  }

  private logLine(line: string): void {
    try { this.log?.(line); } catch { /* Output callbacks cannot alter process lifetime. */ }
  }

  private receive(payload: Buffer): void {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native response.');
    const message = value as Record<string, unknown>;
    if (Object.hasOwn(message, 'id')) {
      if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id < 1 || !Object.hasOwn(message, 'body')) {
        throw new Error('Invalid native response envelope.');
      }
      const pending = this.pending.get(message.id);
      if (pending) this.settle(message.id, pending, undefined, message.body);
    } else {
      try { this.handler?.(message); } catch { this.logLine('Native message handler failed.'); }
    }
  }
}
