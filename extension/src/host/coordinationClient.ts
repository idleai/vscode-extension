import { NativeProcess, NativeProcessOptions, ProcessStartOptions } from './nativeProcess';
import { HostError, record } from './protocol';

interface Pending {
  resolve(value: string): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** f18 framing. Payloads cross the webview boundary as text, preserving Rust u64 values. */
export class CoordinationClient {
  private readonly process: NativeProcess;
  private readonly pending = new Map<string, Pending>();
  private next = 0;
  private queued = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: NativeProcessOptions = {}) {
    this.process = new NativeProcess({
      frame: payload => this.receive(payload),
      closed: () => { for (const id of this.pending.keys()) this.finish(id, new HostError('unavailable', 'Coordination connection closed.')); },
    }, { ...options, byteOrder: 'big', maxFrameBytes: 16 * 1024 * 1024 });
  }

  start(binary: string, options: ProcessStartOptions): void { this.process.start(binary, options); }

  isRunning(): boolean { return this.process.isRunning(); }

  request(command: string, signal?: AbortSignal): Promise<string> {
    if (this.queued >= 64) return Promise.reject(new HostError('busy', 'Coordination is busy. Retry the read.'));
    this.queued++;
    const result = this.tail.then(() => this.send(command, signal));
    this.tail = result.then(() => {}, () => {}).finally(() => { this.queued--; });
    return result;
  }

  private send(command: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new HostError('cancelled', 'Coordination read cancelled.'));
    if (this.pending.size >= 8) return Promise.reject(new HostError('busy', 'Coordination is busy. Retry the read.'));
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      const cancel = (error: HostError) => {
        this.finish(id, error);
        void this.process.write([JSON.stringify({ kind: 'cancel', data: id })]).catch(() => {});
      };
      const abort = () => cancel(new HostError('cancelled', 'Coordination read cancelled.'));
      const timer = setTimeout(() => {
        cancel(new HostError('host_timeout', 'The local coordinator did not respond.'));
      }, 16_000);
      this.pending.set(id, { resolve, reject, cleanup: () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
      } });
      signal?.addEventListener('abort', abort, { once: true });
      void this.process.write([`{"kind":"call","data":{"version":1,"id":"${id}","timeout_ms":15000,"command":`, command, '}}'])
        .catch(() => this.finish(id, new HostError('unavailable', 'Coordination connection closed.')));
    });
  }

  private receive(payload: Buffer): void {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    const response: unknown = JSON.parse(raw);
    if (!record(response) || response.version !== 1 || typeof response.id !== 'string' || !record(response.result)) {
      throw new Error('Invalid coordination response.');
    }
    if (Object.hasOwn(response.result, 'Err')) {
      this.finish(response.id, coordinatorError(response.result.Err));
    } else if (Object.hasOwn(response.result, 'Ok')) this.finish(response.id, undefined, raw);
    else throw new Error('Invalid coordination result.');
  }

  private finish(id: string, error?: Error, value?: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    if (error) pending.reject(error); else pending.resolve(value!);
  }

  shutdown(): Promise<void> { return this.process.shutdown(); }
}

function coordinatorError(error: unknown): HostError {
  switch (error) {
    case 'forbidden': case 'expired': return new HostError('denied', 'Access to this workspace is no longer available.');
    case 'invalid': return new HostError('invalid_request', 'The local coordinator rejected this read.');
    case 'cancelled': case 'timeout': return new HostError('host_timeout', 'The local coordinator did not respond.');
    case 'busy': return new HostError('busy', 'Coordination is busy. Retry the read.');
    default: return new HostError('unavailable', 'The local coordinator could not complete this read.');
  }
}
