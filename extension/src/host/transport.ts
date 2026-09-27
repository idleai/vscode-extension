import { Duplex } from 'node:stream';

/** Flush one raw write, waiting for both its callback and backpressure to clear. */
export function writeTransport(stream: Duplex, bytes: Buffer): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.reject(new Error('Transport is closed.'));
  return new Promise((resolve, reject) => {
    let writing = true;
    let written = false;
    let drained = false;
    let settled = false;
    const cleanup = () => {
      stream.off('close', closed); stream.off('error', failed); stream.off('drain', drain);
    };
    const finish = (error?: Error) => {
      if (settled || (!error && (writing || !written || !drained))) return;
      settled = true;
      if (error && !stream.closed) {
        // Writable callbacks can precede their matching error event. Keep the
        // listener through destruction so that rejection never crashes Node.
        stream.off('drain', drain);
        stream.once('close', cleanup);
        stream.destroy();
      } else cleanup();
      if (error) reject(error); else resolve();
    };
    const closed = () => finish(new Error('Transport closed during a write.'));
    const failed = () => finish(new Error('Transport write failed.'));
    const drain = () => { drained = true; finish(); };
    stream.once('close', closed); stream.once('error', failed); stream.once('drain', drain);
    try {
      const accepted = stream.write(bytes, error => {
        written = true;
        if (error) failed(); else finish();
      });
      drained = accepted || drained;
      writing = false;
      finish();
    } catch { failed(); }
  });
}

/** Reads stay paused while the caller handles a chunk; no peer/progress policy lives here. */
export async function consumeTransport(
  stream: Duplex, consume: (bytes: Buffer) => Promise<void>, maxChunkBytes = 64 * 1024,
): Promise<void> {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) throw new RangeError('Invalid transport chunk limit.');
  try {
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Transport must contain raw bytes.');
      for (let offset = 0; offset < chunk.length; offset += maxChunkBytes) {
        await consume(chunk.subarray(offset, offset + maxChunkBytes));
      }
    }
  } catch {
    throw new Error('Transport read failed.');
  }
}

/** Connects two owned raw streams; Node pipe enforces backpressure in both directions. */
export function bridgeDuplex(left: Duplex, right: Duplex, onClosed?: (error?: Error) => void): { dispose(): void } {
  let closed = false;
  const finish = (error?: Error) => {
    if (closed) return;
    closed = true;
    left.unpipe(right); right.unpipe(left);
    left.off('close', close); right.off('close', close);
    // Keep the guarded error listeners until each stream closes, so errors
    // queued by destroy cannot become unhandled on the extension host.
    if (left.closed) left.off('error', failed); else left.once('close', () => left.off('error', failed));
    if (right.closed) right.off('error', failed); else right.once('close', () => right.off('error', failed));
    left.destroy(); right.destroy();
    onClosed?.(error);
  };
  const close = () => finish();
  const failed = () => finish(new Error('Transport bridge disconnected.'));
  left.on('error', failed); right.on('error', failed);
  left.once('close', close); right.once('close', close);
  if (left.destroyed || right.destroyed) finish(new Error('Transport is closed.'));
  else { left.pipe(right); right.pipe(left); }
  return { dispose: () => finish() };
}
