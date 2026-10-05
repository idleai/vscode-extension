import { NativeProcess, NativeProcessOptions } from './nativeProcess';
import { ConnectionEvents, ConnectionFactory, NativeConnection } from './nativeConnection';
import { record } from './protocol';

const HEADER = 8;
const MAX_FRAME = 160 * 1024 * 1024 + HEADER;
const LIMITS = { capture: 160 * 1024 * 1024, history: 8 * 1024 * 1024,
  collection: 1024 * 1024, repository: 16 * 1024, coordination: 16 * 1024 * 1024 };
type Service = keyof typeof LIMITS;
const enum Kind { Hello, Open, Data, Close, Ready, Closed, Shutdown }

interface Installation { workspace: string; service: { kind: Service; binding: unknown } }
export type NativeServices = Pick<NativeHost, 'connection'>;

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

interface Lease {
  id: number;
  events: ConnectionEvents;
  ready: ReturnType<typeof deferred>;
  done: ReturnType<typeof deferred>;
  timer?: NodeJS.Timeout;
  closing: boolean;
  available: boolean;
  opened: boolean;
}

function header(kind: Kind, channel: number): Buffer {
  const bytes = Buffer.alloc(HEADER);
  bytes[0] = 1; bytes[1] = kind; bytes.writeUInt32LE(channel, 4);
  return bytes;
}

/** The extension's sole native process owner; services retire only their own channels. */
export class NativeHost {
  private process: NativeProcess;
  private readonly channels = new Map<number, Lease>();
  private hello?: ReturnType<typeof deferred>;
  private helloTimer?: NodeJS.Timeout;
  private greeted = false;
  private next = 1;
  private disposed = false;
  private restarting?: Promise<void>;

  constructor(private readonly binary: () => string, private readonly options: NativeProcessOptions = {}) {
    this.process = this.createProcess();
  }

  private createProcess(): NativeProcess {
    return new NativeProcess({ frame: bytes => this.receive(bytes), closed: error => this.failed(error) }, {
      terminationGraceMs: 10_000, shutdownTimeoutMs: 12_000, ...this.options,
      byteOrder: 'little', maxFrameBytes: MAX_FRAME, maxQueuedBytes: 192 * 1024 * 1024,
    });
  }

  connection(workspace: string, kind: Service, binding: unknown): ConnectionFactory {
    // Snapshot installation data once; later caller mutations cannot change a channel's scope.
    const installation = JSON.stringify({ workspace, service: { kind, binding } } satisfies Installation);
    if (Buffer.byteLength(installation) > 64 * 1024) throw new Error('Native service binding is too large.');
    return events => new HostChannel(this, installation, LIMITS[kind], events);
  }

  open(installation: string, events: ConnectionEvents): Lease {
    if (this.disposed) throw new Error('Native host is closed.');
    if (this.restarting) throw new Error('Native host is restarting.');
    if (!this.hello) this.start();
    if (this.channels.size >= 64 || this.next > 0xffffffff) throw new Error('Native host channel limit reached.');
    const lease: Lease = { id: this.next++, events, ready: deferred(), done: deferred(), closing: false, available: false, opened: false };
    this.channels.set(lease.id, lease);
    lease.timer = setTimeout(() => this.close(lease, new Error('Native service startup timed out.')), 15_000);
    void this.hello!.promise.then(async () => {
      if (this.channels.get(lease.id) !== lease || lease.closing) return;
      lease.opened = true;
      await this.process.write([header(Kind.Open, lease.id), installation]);
    }).catch(() => this.finish(lease, new Error('Native service could not start.')));
    return lease;
  }

  async write(lease: Lease, parts: readonly (string | Buffer)[]): Promise<void> {
    await lease.ready.promise;
    if (lease.closing || this.channels.get(lease.id) !== lease) throw new Error('Native service channel is closed.');
    await this.process.write([header(Kind.Data, lease.id), ...parts]);
  }

  close(lease: Lease, error = new Error('Native service channel closed.')): void {
    if (lease.closing || this.channels.get(lease.id) !== lease) return;
    lease.closing = true;
    clearTimeout(lease.timer);
    lease.ready.reject(error);
    lease.events.closed(error);
    if (!lease.opened) { this.finish(lease, error); return; }
    // Close follows Open through the same ordered process write queue.
    void this.hello?.promise.then(() => {
      if (this.channels.get(lease.id) === lease) this.sendClose(lease);
    }).catch(() => {});
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    this.failed(new Error('Native host is closed.'));
    await this.process.shutdown();
  }

  restart(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Native host is closed.'));
    if (this.restarting) return this.restarting;
    this.failed(new Error('Native host is restarting.'));
    const work = this.process.shutdown().then(() => {
      if (!this.disposed) this.process = this.createProcess();
    }).finally(() => { this.restarting = undefined; });
    this.restarting = work;
    return work;
  }

  private start(): void {
    const binary = this.binary();
    this.next = 1;
    this.greeted = false;
    const hello = this.hello = deferred();
    void this.process.waitForExit().then(() => {
      if (this.hello !== hello || this.disposed) return;
      if (!this.channels.size) { this.failed(new Error('Native host startup was cancelled.')); return; }
      this.helloTimer = setTimeout(() => this.process.stop(), 10_000);
      this.process.start(binary);
    }).catch(() => {
      if (this.hello === hello) this.failed(new Error('Native host could not start.'));
    });
  }

  private receive(bytes: Buffer): void {
    if (bytes.length < HEADER || bytes[0] !== 1 || bytes[2] !== 0 || bytes[3] !== 0) throw new Error('Invalid native host frame.');
    const kind = bytes[1], id = bytes.readUInt32LE(4), payload = bytes.subarray(HEADER);
    if (kind === Kind.Hello && id === 0) {
      if (!this.hello || this.greeted || payload.length > 64 * 1024) throw new Error('Unexpected native host handshake.');
      const hello: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
      if (!record(hello) || hello.version !== 1 || !record(hello.services)
        || Object.keys(LIMITS).some(service => (hello.services as Record<string, unknown>)[service] !== 1)) {
        throw new Error('Incompatible native host services.');
      }
      clearTimeout(this.helloTimer);
      this.greeted = true;
      this.hello.resolve();
      return;
    }
    if (!this.greeted || !id || ![Kind.Ready, Kind.Data, Kind.Closed].includes(kind)) throw new Error('Unexpected native host frame.');
    const lease = this.channels.get(id);
    if (!lease) return;
    if (kind === Kind.Closed) { this.finish(lease, closedError(payload)); return; }
    if (lease.closing) return;
    if (kind === Kind.Ready) {
      if (payload.length || lease.available) throw new Error('Invalid native service acknowledgement.');
      lease.available = true; clearTimeout(lease.timer); lease.ready.resolve();
    } else {
      if (!lease.available) throw new Error('Native service replied before opening.');
      try { lease.events.frame(payload); }
      catch { this.close(lease, new Error('Invalid native service response.')); }
    }
  }

  private sendClose(lease: Lease): void {
    if (this.channels.get(lease.id) !== lease) return;
    void this.process.write([header(Kind.Close, lease.id)]).catch(() => {
      if (this.channels.get(lease.id) !== lease) return;
      // A full write queue is not a native close acknowledgement. Keep ownership
      // and retry the small control frame as the pipe drains.
      lease.timer = setTimeout(() => this.sendClose(lease), 25);
      lease.timer.unref();
    });
  }

  private finish(lease: Lease, error: Error): void {
    if (this.channels.get(lease.id) !== lease) return;
    this.channels.delete(lease.id);
    clearTimeout(lease.timer);
    lease.ready.reject(error);
    if (!lease.closing) { lease.closing = true; lease.events.closed(error); }
    lease.done.resolve();
  }

  private failed(error: Error): void {
    clearTimeout(this.helloTimer);
    this.hello?.reject(error);
    this.hello = undefined;
    for (const lease of this.channels.values()) this.finish(lease, error);
  }
}

function closedError(payload: Buffer): Error {
  if (payload.length > 1024) throw new Error('Invalid native channel close.');
  const response: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  const messages: Record<string, string> = {
    closed: 'Native service channel closed.', busy: 'Native host has no available service channels.',
    invalid_request: 'Native service binding was rejected.', unavailable: 'Native service could not complete its work.',
  };
  if (!record(response) || typeof response.code !== 'string' || !Object.hasOwn(messages, response.code)) {
    throw new Error('Invalid native channel close.');
  }
  return new Error(messages[response.code]);
}

class HostChannel implements NativeConnection {
  private current?: Lease;
  private readonly retiring = new Set<Promise<void>>();
  private disposed = false;

  constructor(private readonly host: NativeHost, private readonly installation: string,
    private readonly maximum: number, private readonly events: ConnectionEvents) {}

  isRunning(): boolean { return !!this.current && !this.current.closing; }

  start(): void {
    if (this.disposed) throw new Error('Native service connection is disposed.');
    if (!this.isRunning()) this.current = this.host.open(this.installation, this.events);
  }

  write(parts: readonly (string | Buffer)[]): Promise<void> {
    if (!this.current || !this.isRunning()) return Promise.reject(new Error('Native service channel is not running.'));
    if (parts.reduce((size, part) => size + Buffer.byteLength(part), 0) > this.maximum) {
      return Promise.reject(new Error('Native service request is too large.'));
    }
    return this.host.write(this.current, parts);
  }

  stop(): void {
    const lease = this.current;
    this.current = undefined;
    if (!lease) return;
    this.host.close(lease);
    const closing = lease.done.promise;
    this.retiring.add(closing);
    void closing.then(() => this.retiring.delete(closing), () => {});
  }

  dispose(): void { this.disposed = true; this.stop(); }

  async shutdown(): Promise<void> {
    this.dispose();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.all(this.retiring), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native service shutdown timed out.')), 10_000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
