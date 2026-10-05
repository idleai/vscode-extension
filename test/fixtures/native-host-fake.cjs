const { fakeChild } = require('./process-fake.cjs');
const { FrameDecoder, encodeFrame } = require('../../out/host/frameDecoder');
const { NativeHost } = require('../../out/host/nativeHost');

const maximum = 160 * 1024 * 1024 + 8;
const services = { capture: 1, history: 1, collection: 1, repository: 1, coordination: 1 };
function routed(kind, id, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header[0] = 1; header[1] = kind; header.writeUInt32LE(id, 4);
  return encodeFrame([header, payload], maximum);
}

function harness(t, options = {}) {
  const processes = [], channels = [];
  const host = new NativeHost(() => '/packaged/idle-host', { spawn(binary, args, spawnOptions) {
    const child = fakeChild({ ignoresTerm: options.ignoresTerm });
    Object.assign(child, { binary, args, options: spawnOptions });
    const decoder = new FrameDecoder(maximum), active = new Map();
    const write = child.stdin.write;
    child.send = (kind, id, payload) => child.stdout.emit('data', routed(kind, id, payload));
    child.hello = (versions = services) => child.send(0, 0, JSON.stringify({ version: 1, services: versions }));
    child.stdin.write = (bytes, callback) => {
      const accepted = write(bytes, callback);
      for (const frame of decoder.push(bytes)) {
        const kind = frame[1], id = frame.readUInt32LE(4), raw = frame.subarray(8);
        if (kind === 1) {
          const channel = { id, child, installation: JSON.parse(raw), requests: [], raw: [], closed: false,
            reply(value) { child.send(2, id, JSON.stringify(value)); },
            replyRaw(value) { child.send(2, id, value); },
            acknowledgeClose() { child.send(5, id, '{"code":"closed"}'); },
          };
          active.set(id, channel); channels.push(channel);
          queueMicrotask(() => child.send(4, id));
        } else if (kind === 2) {
          const channel = active.get(id);
          const request = JSON.parse(raw);
          channel.raw.push(Buffer.from(raw)); channel.requests.push(request);
          options.request?.(channel, request);
        } else if (kind === 3) {
          const channel = active.get(id);
          if (channel) channel.closed = true;
          if (!options.holdClose) queueMicrotask(() => child.send(5, id, '{"code":"closed"}'));
        }
      }
      return accepted;
    };
    processes.push(child);
    if (!options.manualHello) queueMicrotask(() => child.hello());
    return child;
  } });
  t?.after(async () => {
    for (const child of processes) { child.emit('exit', 0); child.emit('close'); }
    await host.shutdown();
  });
  return { host, processes, channels };
}

module.exports = { harness, routed, services };
