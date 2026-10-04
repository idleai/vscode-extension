import { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio, spawn } from 'node:child_process';
import { ByteOrder, DEFAULT_MAX_FRAME_BYTES, FrameDecoder, encodeFrame } from './frameDecoder';

export interface ProcessStartOptions {
  readonly args?: readonly string[];
  /** Filesystem operations run in this explicitly selected file-owning host directory. */
  readonly cwd?: string;
}

export type ProcessSpawner = (
  binary: string, args: readonly string[], options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export interface NativeProcessOptions {
  readonly spawn?: ProcessSpawner;
  readonly maxFrameBytes?: number;
  readonly byteOrder?: ByteOrder;
  readonly maxQueuedBytes?: number;
  readonly terminationGraceMs?: number;
  readonly shutdownTimeoutMs?: number;
}

interface ProcessEvents {
  frame(payload: Buffer): void;
  closed(error: Error): void;
  /** Opt-in raw stderr. Consumers must consider diagnostic data sensitive. */
  log?(line: string): void;
}

interface Write {
  frame: Buffer;
  resolve(): void;
  reject(error: Error): void;
}

interface Generation {
  child: ChildProcessWithoutNullStreams;
  decoder: FrameDecoder;
  writes: Write[];
  queuedBytes: number;
  writing: boolean;
}

interface OwnedChild {
  child: ChildProcessWithoutNullStreams;
  terminating: boolean;
  killTimer?: NodeJS.Timeout;
}

interface ShutdownWaiter {
  resolve(): void;
  timer: NodeJS.Timeout;
}

/** Owns only framing, bounded writes and OS process lifetime; no application state. */
export class NativeProcess {
  private current?: Generation;
  private readonly children = new Map<ChildProcessWithoutNullStreams, OwnedChild>();
  private readonly maxFrameBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly terminationGraceMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly shutdownWaiters = new Set<ShutdownWaiter>();
  private disposed = false;

  constructor(private readonly events: ProcessEvents, private readonly options: NativeProcessOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    // Validate the frame limit before creating a process.
    new FrameDecoder(this.maxFrameBytes, this.options.byteOrder);
    this.maxQueuedBytes = options.maxQueuedBytes ?? 2 * (this.maxFrameBytes + 4);
    this.terminationGraceMs = options.terminationGraceMs ?? 1000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.maxQueuedBytes) || this.maxQueuedBytes < 4 ||
      !Number.isSafeInteger(this.terminationGraceMs) || this.terminationGraceMs < 0 || this.terminationGraceMs > 0x7fffffff ||
      !Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 1 || this.shutdownTimeoutMs > 0x7fffffff) {
      throw new RangeError('Invalid native process limits.');
    }
  }

  isRunning(): boolean { return this.current !== undefined; }

  start(binary: string, options: ProcessStartOptions = {}): void {
    if (this.disposed) throw new Error('Native process owner is disposed.');
    if (this.current) return;
    const child = (this.options.spawn ?? spawn)(binary, [...(options.args ?? [])], {
      cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const owned: OwnedChild = { child, terminating: false };
    this.children.set(child, owned);
    const generation: Generation = {
      child, decoder: new FrameDecoder(this.maxFrameBytes, this.options.byteOrder), writes: [], queuedBytes: 0, writing: false,
    };
    this.current = generation;
    child.stdout.on('data', (chunk: Buffer) => this.receive(generation, chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.current === generation) {
        try { this.events.log?.(chunk.toString('utf8')); } catch { /* A diagnostic sink must not crash the host. */ }
      }
    });
    child.stdin.on('error', () => this.fail(generation, new Error('Native process input failed.')));
    child.stdout.on('error', () => this.fail(generation, new Error('Native process output failed.')));
    child.stderr.on('error', () => this.fail(generation, new Error('Native process diagnostics closed.')));
    child.stdout.on('end', () => this.fail(generation, new Error('Native process output closed.')));
    child.on('error', () => this.fail(generation, new Error('Cannot start or signal the native process.')));
    child.on('exit', (code: number | null) => {
      this.release(owned);
      this.fail(generation, new Error(`Native process exited with code ${code ?? 'unknown'}.`));
    });
    child.on('close', () => {
      this.release(owned);
      this.fail(generation, new Error('Native process closed.'));
    });
  }

  write(parts: readonly (string | Buffer)[]): Promise<void> {
    const generation = this.current;
    if (!generation) return Promise.reject(new Error('Native process is not running.'));
    let frame: Buffer;
    try {
      const frameLength = 4 + parts.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
      if (generation.queuedBytes + frameLength > this.maxQueuedBytes) {
        throw new Error('Native process write queue is full.');
      }
      frame = encodeFrame(parts, this.maxFrameBytes, this.options.byteOrder);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      generation.writes.push({ frame, resolve, reject });
      generation.queuedBytes += frame.length;
      this.flush(generation);
    });
  }

  stop(): void {
    if (this.current) this.fail(this.current, new Error('Native process stopped.'));
    for (const owned of this.children.values()) this.terminate(owned);
  }

  dispose(): void { this.disposed = true; this.stop(); }

  /** Await OS-confirmed termination during deactivation, with a bounded wait. */
  shutdown(): Promise<void> {
    this.dispose();
    if (!this.children.size) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: ShutdownWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.shutdownWaiters.delete(waiter);
          // The timeout only ends this wait. Owned children and their kill
          // attempts remain tracked until the OS reports exit or close.
          reject(new Error('Native process shutdown timed out.'));
        }, this.shutdownTimeoutMs),
      };
      this.shutdownWaiters.add(waiter);
    });
  }

  private receive(generation: Generation, chunk: Buffer): void {
    if (this.current !== generation) return;
    try {
      for (const payload of generation.decoder.push(chunk)) {
        if (this.current !== generation) return;
        this.events.frame(payload);
      }
    } catch {
      // JSON parser messages may embed private native payloads. Never forward them.
      this.fail(generation, new Error('Invalid native process framing or response.'));
    }
  }

  private flush(generation: Generation): void {
    if (this.current !== generation || generation.writing || !generation.writes.length) return;
    const write = generation.writes[0];
    generation.writing = true;
    try {
      generation.child.stdin.write(write.frame, (error?: Error | null) => {
        if (this.current !== generation) return;
        if (error) { this.fail(generation, new Error('Native process input failed.')); return; }
        generation.writes.shift();
        generation.queuedBytes -= write.frame.length;
        generation.writing = false;
        write.resolve();
        // A stream callback means this frame has been consumed. Only then write
        // the next frame; native backpressure cannot create unbounded buffering.
        queueMicrotask(() => this.flush(generation));
      });
    } catch {
      this.fail(generation, new Error('Native process write failed.'));
    }
  }

  private fail(generation: Generation, error: Error): void {
    const owned = this.children.get(generation.child);
    if (owned) this.terminate(owned);
    if (this.current !== generation) return;
    this.current = undefined;
    for (const write of generation.writes) write.reject(error);
    generation.writes = [];
    generation.queuedBytes = 0;
    this.events.closed(error);
  }

  private terminate(owned: OwnedChild): void {
    if (owned.terminating) return;
    owned.terminating = true;
    // child.killed means a signal was sent, not that it exited. Retain ownership
    // until exit/close, even when a replacement is already serving requests.
    owned.killTimer = setTimeout(() => this.forceTermination(owned), this.terminationGraceMs);
    this.signal(owned.child, 'SIGTERM');
  }

  private forceTermination(owned: OwnedChild): void {
    owned.killTimer = undefined;
    if (!this.children.has(owned.child)) return;
    this.signal(owned.child, 'SIGKILL');
    if (this.children.has(owned.child)) {
      // A transient OS refusal must not abandon a process after a shutdown
      // wait times out. Retry without keeping an otherwise exited host alive.
      owned.killTimer = setTimeout(() => this.forceTermination(owned), 1000);
      owned.killTimer.unref();
    }
  }

  private signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try { child.kill(signal); } catch { /* Ownership is retained until an OS exit/close event. */ }
  }

  private release(owned: OwnedChild): void {
    clearTimeout(owned.killTimer);
    this.children.delete(owned.child);
    if (!this.children.size) {
      for (const waiter of this.shutdownWaiters) { clearTimeout(waiter.timer); waiter.resolve(); }
      this.shutdownWaiters.clear();
    }
  }
}
