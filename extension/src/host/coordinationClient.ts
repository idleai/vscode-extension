import { NativeProcess, NativeProcessOptions, ProcessStartOptions } from './nativeProcess';
import { ConnectionFactory, NativeConnection } from './nativeConnection';
import { HostError, record } from './protocol';

export type CredentialPurpose = 'management' | 'discovery';

interface Pending {
  resolve(value: string): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** f18 framing. Payloads cross the webview boundary as text, preserving Rust u64 values. */
export class CoordinationClient {
  private readonly process: NativeConnection;
  private readonly pending = new Map<string, Pending>();
  private next = 0;
  private generation = 0;
  private closed = false;
  private readonly credentialRequests = new Set<string>();
  private queued = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: NativeProcessOptions = {}, private readonly credential?: (purpose: CredentialPurpose) => Promise<string | undefined>, connect?: ConnectionFactory) {
    this.process = (connect ?? (events => new NativeProcess(events, { ...options, byteOrder: 'big', maxFrameBytes: 16 * 1024 * 1024 })))({
      frame: payload => this.receive(payload),
      closed: () => { this.generation++; this.credentialRequests.clear(); for (const id of this.pending.keys()) this.finish(id, new HostError('unavailable', 'Coordination connection closed.')); },
    });
  }

  start(binary = '', options?: ProcessStartOptions): void { this.process.start(binary, options); }

  isRunning(): boolean { return this.process.isRunning(); }

  request(command: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<string> {
    if (this.queued >= 64) return Promise.reject(new HostError('busy', 'Coordination is busy. Retry the read.'));
    this.queued++;
    const result = this.tail.then(() => this.send(command, signal, timeoutMs));
    this.tail = result.then(() => {}, () => {}).finally(() => { this.queued--; });
    return result;
  }

  private send(command: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<string> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return Promise.reject(new HostError('invalid_request', 'Invalid coordination timeout.'));
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
      }, timeoutMs + 1000);
      this.pending.set(id, { resolve, reject, cleanup: () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
      } });
      signal?.addEventListener('abort', abort, { once: true });
      void this.process.write([`{"kind":"call","data":{"version":1,"id":"${id}","timeout_ms":${timeoutMs},"command":`, command, '}}'])
        .catch(() => this.finish(id, new HostError('unavailable', 'Coordination connection closed.')));
    });
  }

  private receive(payload: Buffer): void {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    const response: unknown = JSON.parse(raw);
    if (record(response) && response.kind === 'credential') { this.receiveCredential(response.data); return; }
    if (!record(response) || response.version !== 1 || typeof response.id !== 'string' || !record(response.result)) {
      throw new Error('Invalid coordination response.');
    }
    if (Object.hasOwn(response.result, 'Err')) {
      this.finish(response.id, coordinatorError(response.result.Err));
    } else if (Object.hasOwn(response.result, 'Ok')) this.finish(response.id, undefined, raw);
    else throw new Error('Invalid coordination result.');
  }

  private receiveCredential(value: unknown): void {
    if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 256
      || !['management', 'discovery'].includes(String(value.purpose)) || this.credentialRequests.has(value.id)
      || this.credentialRequests.size >= 8) throw new Error('Invalid credential request.');
    const id = value.id, generation = this.generation;
    this.credentialRequests.add(id);
    void (async () => {
      let token: string | undefined;
      try { if (!this.closed) token = await this.credential?.(value.purpose as CredentialPurpose); } catch { /* Fixed denial below. */ }
      if (generation !== this.generation || !this.process.isRunning()) return;
      if (this.closed || !token || token.length > 65_536) token = undefined;
      await this.process.write([JSON.stringify({ kind: 'credential', data: { id, token: token ?? null } })]);
    })().catch(() => {}).finally(() => this.credentialRequests.delete(id));
  }

  private finish(id: string, error?: Error, value?: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    if (error) pending.reject(error); else pending.resolve(value!);
  }

  shutdown(): Promise<void> { this.closed = true; this.generation++; return this.process.shutdown(); }
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
