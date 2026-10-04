/** A deliberate allocation limit for history frames, configurable by the host. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export type ByteOrder = "little" | "big";

/** Length-prefixed frames, assembled with one copy per input byte. */
export class FrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;
  private failed = false;

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, private readonly byteOrder: ByteOrder = "little") {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 0xffffffff) {
      throw new RangeError('Invalid native frame limit.');
    }
  }

  *push(chunk: Buffer): Generator<Buffer> {
    if (this.failed) throw new Error('Native frame decoder is closed.');
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const length = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + length);
        this.headerBytes += length;
        offset += length;
        if (this.headerBytes < 4) break;
        const size = this.byteOrder === "big" ? this.header.readUInt32BE() : this.header.readUInt32LE();
        if (size > this.maxFrameBytes) {
          this.failed = true;
          throw new Error('Native frame exceeds the configured limit.');
        }
        this.payload = Buffer.allocUnsafe(size);
      }
      const length = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      chunk.copy(this.payload, this.payloadBytes, offset, offset + length);
      this.payloadBytes += length;
      offset += length;
      if (this.payloadBytes < this.payload.length) break;
      const complete = this.payload;
      this.payload = undefined;
      this.payloadBytes = 0;
      this.headerBytes = 0;
      yield complete;
    }
  }
}

/** Copy serialized UTF-8 parts directly into their final frame. */
export function encodeFrame(parts: readonly (string | Buffer)[], limit: number, byteOrder: ByteOrder = "little"): Buffer {
  const length = parts.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
  if (length > limit || length > 0xffffffff) throw new Error('Native request exceeds the configured limit.');
  const frame = Buffer.allocUnsafe(4 + length);
  if (byteOrder === "big") frame.writeUInt32BE(length); else frame.writeUInt32LE(length);
  let offset = 4;
  for (const part of parts) {
    offset += typeof part === 'string' ? frame.write(part, offset, 'utf8') : part.copy(frame, offset);
  }
  return frame;
}
