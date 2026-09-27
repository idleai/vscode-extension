'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { EventEmitter } = require('node:events');
const { writeTransport, bridgeDuplex, consumeTransport } = require('../out/host/transport');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('transport writes await both flush completion and drain in either event order', async () => {
  for (const callbackFirst of [true, false]) {
    const stream = new EventEmitter();
    let callback;
    stream.write = (_bytes, done) => { callback = done; return false; };
    let complete = false;
    const write = writeTransport(stream, Buffer.from('hello')).then(() => { complete = true; });
    if (callbackFirst) callback(); else stream.emit('drain');
    await tick();
    assert.equal(complete, false);
    if (callbackFirst) stream.emit('drain'); else callback();
    await write;
    assert.equal(stream.listenerCount('drain'), 0);
    assert.equal(stream.listenerCount('error'), 0);
    assert.equal(stream.listenerCount('close'), 0);
  }
});

test('failed writable callbacks cannot leave an unhandled subsequent error event', async () => {
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(new Error('private transport details')); },
  });
  await assert.rejects(writeTransport(stream, Buffer.from('hello')), /Transport write failed/);
  await tick();
  assert.equal(stream.destroyed, true);
  assert.equal(stream.listenerCount('error'), 0);
});

test('closing a stream settles a stalled write and removes listeners', async () => {
  const stream = new Duplex({ read() {}, write() {} });
  const write = writeTransport(stream, Buffer.from('hello'));
  stream.destroy();
  await assert.rejects(write, /closed during a write/);
  assert.equal(stream.listenerCount('error'), 0);
  await assert.rejects(writeTransport(stream, Buffer.from('again')), /closed/);
});

test('raw bridge forwards both directions and pauses input under backpressure', async () => {
  const leftWrites = [];
  const rightWrites = [];
  const pending = [];
  const left = new Duplex({
    read() {},
    write(chunk, _encoding, done) { leftWrites.push(Buffer.from(chunk)); done(); },
  });
  const right = new Duplex({
    highWaterMark: 1,
    read() {},
    write(chunk, _encoding, done) { rightWrites.push(Buffer.from(chunk)); pending.push(done); },
  });
  let closed = 0;
  const bridge = bridgeDuplex(left, right, () => closed++);
  left.push(Buffer.from('one'));
  left.push(Buffer.from('two'));
  right.push(Buffer.from('return'));
  await tick();
  assert.equal(left.isPaused(), true);
  assert.deepEqual(rightWrites.map(value => value.toString()), ['one']);
  assert.deepEqual(leftWrites.map(value => value.toString()), ['return']);
  pending.shift()();
  await tick();
  assert.deepEqual(rightWrites.map(value => value.toString()), ['one', 'two']);
  bridge.dispose(); bridge.dispose();
  await tick();
  assert.equal(closed, 1);
  assert.equal(left.destroyed, true);
  assert.equal(right.destroyed, true);
  assert.equal(left.listenerCount('error'), 0);
  assert.equal(right.listenerCount('error'), 0);
});

test('transport consumption bounds native input and handles one chunk at a time', async () => {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const received = [];
  let active = 0;
  const consumed = consumeTransport(stream, async bytes => {
    active++;
    assert.equal(active, 1);
    received.push(Buffer.from(bytes));
    await tick();
    active--;
  }, 3);
  stream.push(Buffer.from('0123456789')); stream.push(null);
  await consumed;
  assert.deepEqual(received.map(bytes => bytes.length), [3, 3, 3, 1]);
  assert.equal(Buffer.concat(received).toString(), '0123456789');
});
