import { NativeProcess, NativeProcessOptions, ProcessStartOptions } from './nativeProcess';

export const CONTROL_LIMIT = 512 * 1024;
export const INPUT_LIMIT = 64 * 1024;

export class NativePeerError extends Error {}

export interface NativeWorkerOptions extends NativeProcessOptions, ProcessStartOptions {
  readonly timeoutMs?: number;
}

interface PendingResponse {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** The peer worker has a distinct, serialized {ok, result/error} control protocol. */
export class NativeWorker {
  private readonly process: NativeProcess;
  private readonly timeoutMs: number;
  private pending?: PendingResponse;

  constructor(binary: string, options: NativeWorkerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 0x7fffffff) {
      throw new RangeError('Invalid native worker timeout.');
    }
    this.process = new NativeProcess({
      frame: payload => this.receive(payload),
      closed: error => this.rejectPending(new NativePeerError(error.message)),
    }, { ...options, maxFrameBytes: options.maxFrameBytes ?? CONTROL_LIMIT });
    this.process.start(binary, options);
  }

  request(body: unknown): Promise<unknown> {
    if (!this.process.isRunning()) return Promise.reject(new NativePeerError('Native multiplayer worker is closed.'));
    if (this.pending) return Promise.reject(new NativePeerError('Native multiplayer requests must be serialized.'));
    let serialized: string | undefined;
    try { serialized = JSON.stringify(body); } catch { return Promise.reject(new NativePeerError('Native request is not JSON serializable.')); }
    if (serialized === undefined) return Promise.reject(new NativePeerError('Native request is not JSON serializable.'));
    return new Promise((resolve, reject) => {
      const pending: PendingResponse = {
        resolve, reject,
        timer: setTimeout(() => {
          this.rejectPending(new NativePeerError('Native multiplayer request timed out.'));
          // No IDs exist in this protocol: a late response cannot be assigned
          // safely to a later request, so a timeout always closes the worker.
          this.process.stop();
        }, this.timeoutMs),
      };
      this.pending = pending;
      void this.process.write([serialized]).catch(error => {
        if (this.pending === pending) this.rejectPending(new NativePeerError(error instanceof Error ? error.message : 'Native input failed.'));
      });
    });
  }

  stop(): void { this.process.stop(); }

  dispose(): void { this.process.dispose(); }

  shutdown(): Promise<void> { return this.process.shutdown(); }

  private receive(payload: Buffer): void {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativePeerError('Invalid native response.');
    const message = value as Record<string, unknown>;
    const pending = this.pending;
    if (!pending || typeof message.ok !== 'boolean') throw new NativePeerError('Unexpected native response.');
    if (message.ok && !Object.hasOwn(message, 'result')) throw new NativePeerError('Invalid native result.');
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else {
      // Return only fixed error codes, never arbitrary Rust/peer diagnostic text.
      const codes: readonly unknown[] = [
        'incompatible_peer_protocol', 'sharing_scope_changed', 'authentication_failed',
        'storage_permission_denied', 'storage_busy', 'invalid_request_or_peer_data',
        'connection_closed', 'storage_or_transport_failure',
      ];
      const code = codes.includes(message.error) ? String(message.error) : 'invalid_native_response';
      pending.reject(new NativePeerError(`Native multiplayer: ${code}`));
    }
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}
