'use strict';

const { EventEmitter } = require('node:events');

function frame(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

function fakeChild({ writesComplete = true, ignoresTerm = false, writeError } = {}) {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.writes = [];
  child.callbacks = [];
  child.signals = [];
  child.stdin.write = (bytes, callback) => {
    if (writeError) throw writeError;
    child.writes.push(Buffer.from(bytes));
    child.callbacks.push(callback);
    if (writesComplete) queueMicrotask(() => callback());
    return true;
  };
  child.kill = signal => {
    child.signals.push(signal);
    if (!ignoresTerm || signal === 'SIGKILL') queueMicrotask(() => {
      child.emit('exit', null, signal);
      child.emit('close');
    });
    return true;
  };
  child.reply = value => child.stdout.emit('data', frame(value));
  return child;
}

module.exports = { frame, fakeChild };
