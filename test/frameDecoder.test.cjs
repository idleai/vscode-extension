'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FrameDecoder, encodeFrame } = require('../out/host/frameDecoder');
const { frame } = require('./fixtures/process-fake.cjs');

test('frames preserve arbitrary fragmentation, empty payloads and Unicode', () => {
  const payloads = [Buffer.from('a→b'), Buffer.alloc(0), Buffer.from('{"revision":2}')];
  const stream = Buffer.concat(payloads.map(frame));
  for (let split = 0; split <= stream.length; split++) {
    const decoder = new FrameDecoder();
    assert.deepEqual([...decoder.push(stream.subarray(0, split)), ...decoder.push(stream.subarray(split))], payloads);
  }
  const decoder = new FrameDecoder();
  assert.deepEqual(Array.from(stream).flatMap(byte => [...decoder.push(Buffer.from([byte]))]), payloads);
});

test('fragmented large frames copy input bytes once without repeated concatenation', () => {
  const payload = Buffer.from('snapshot→git'.repeat(30000));
  const bytes = frame(payload);
  const decoder = new FrameDecoder();
  const originalCopy = Buffer.prototype.copy;
  let copied = 0;
  const messages = [];
  Buffer.prototype.copy = function (...args) {
    const length = originalCopy.apply(this, args);
    copied += length;
    return length;
  };
  try {
    for (let offset = 0; offset < bytes.length; offset += 1023) {
      messages.push(...decoder.push(bytes.subarray(offset, offset + 1023)));
    }
  } finally { Buffer.prototype.copy = originalCopy; }
  assert.deepEqual(messages, [payload]);
  assert.equal(copied, bytes.length);
});

test('oversized headers fail before payload allocation and poison the decoder', () => {
  const decoder = new FrameDecoder(16);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(0xffffffff);
  assert.throws(() => [...decoder.push(header)], /configured limit/);
  assert.throws(() => [...decoder.push(frame(Buffer.from('ok')))], /closed/);
  assert.throws(() => new FrameDecoder(0), /limit/);
});

test('serialized frame parts retain exact bytes and enforce the full envelope limit', () => {
  const parts = ['{"id":1,"body":', Buffer.from('"😀 é\\n\\\""'), '}'];
  const encoded = encodeFrame(parts, 100);
  assert.equal(encoded.readUInt32LE(), encoded.length - 4);
  assert.equal(encoded.subarray(4).toString(), parts.join(''));
  assert.throws(() => encodeFrame(parts, encoded.length - 5), /limit/);
});
