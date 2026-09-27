'use strict';

const mode = process.argv[2];
const send = value => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
};

if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  // Leave an incomplete frame behind when the parent stops this generation.
  send({ ready: true });
  const partial = Buffer.alloc(4);
  partial.writeUInt32LE(256);
  process.stdout.write(partial);
  process.stdin.resume();
} else {
  let buffered = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE();
      if (buffered.length < length + 4) return;
      const message = JSON.parse(buffered.subarray(4, length + 4).toString('utf8'));
      buffered = buffered.subarray(length + 4);
      if (mode === 'worker') send({ ok: true, result: { echo: message, cwd: process.cwd() } });
      else send({ id: message.id, body: { echo: message.body, cwd: process.cwd() } });
    }
  });
}
