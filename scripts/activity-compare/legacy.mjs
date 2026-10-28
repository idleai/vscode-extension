import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { rawManifest } from './fixture.mjs';

const prefix = '/legacy/';
const readRequests = new Set(['GetWindow', 'ReconcileRows', 'LocateRows', 'FindInHistory']);
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.wasm': 'application/wasm' };

/** Mount the shipped Rust renderer against its own native reader and copied chain. */
export async function createLegacyAdapter({ legacyRoot, servicePath, workspace, gitRoot = workspace, runDirectory, record = () => {} }) {
  const extensionRoot = join(resolve(legacyRoot), 'extensions/vscode-editchain');
  const assets = join(extensionRoot, 'media');
  const source = await readFile(join(extensionRoot, 'src/extension.ts'), 'utf8');
  const template = source.match(/return `(<\!DOCTYPE html>[\s\S]*?<\/html>)`;/)?.[1];
  if (!template) throw new Error('The legacy checkout has no supported production HTML template.');
  const harness = await readFile(join(extensionRoot, 'test/harness/rust.html'), 'utf8');
  const theme = harness.match(/<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/)?.[1];
  if (!theme) throw new Error('The legacy checkout has no workbench theme fixture.');
  const sessions = new Map();
  const sourceInputs = await rawManifest(workspace);
  const metadata = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: legacyRoot, encoding: 'utf8' }).trim(),
    root: resolve(legacyRoot),
    service: resolve(servicePath),
    serviceSha256: await sha256(servicePath),
    rendererSha256: await sha256(join(assets, 'rust-history/pkg/editchain_history_renderer_bg.wasm')),
    sourceHtmlSha256: createHash('sha256').update(template).digest('hex'),
    mode: 'OpenLivePaged',
  };

  async function mount(profile) {
    const id = randomUUID();
    const directory = join(runDirectory, 'legacy', id);
    const chain = join(directory, '.editchain');
    await mkdir(chain, { recursive: true });
    if (profile !== 'git') {
      const original = join(workspace, '.editchain');
      for (const item of await readdir(original, { withFileTypes: true })) {
        if ((item.isFile() && item.name.endsWith('.eclog')) || (item.isDirectory() && item.name === 'blobs')) {
          await cp(join(original, item.name), join(chain, item.name), { recursive: true });
        }
      }
    }
    const inputs = await rawManifest(directory);
    if (profile !== 'git' && inputs.digest !== sourceInputs.digest) {
      throw new Error('Legacy session raw files do not match the supplied workspace.');
    }
    const log = event => record({ side: 'legacy', session: id, profile, ...event });
    const native = nativeService(servicePath, directory, log);
    const session = new LegacySession(native, { workspace_path: gitRoot, chain_dir: chain }, log, directory, inputs);
    sessions.set(id, session);
    await log({ kind: 'session', directory, workspace, chain, inputs: { count: inputs.count, digest: inputs.digest } });
    return id;
  }

  return {
    metadata,
    async handle(request, response, url) {
      if (!url.pathname.startsWith(prefix)) return false;
      if (url.pathname === prefix && request.method === 'GET') {
        const profile = url.searchParams.get('profile') === 'git' ? 'git' : 'all';
        const session = await mount(profile);
        const html = template
          .replaceAll('${cspSource}', url.origin)
          .replaceAll('${mainStyleUri}', `${prefix}assets/main.css`)
          .replaceAll('${rustLoaderUri}', `${prefix}assets/rust-history/loader.js`)
          .replace('</head>', '<link rel="stylesheet" href="/compare-theme.css">\n</head>')
          .replace('<script type="module"', `<script src="${prefix}bridge.js?session=${session}"></script>\n<script src="/compare-observer.js"></script>\n<script type="module"`);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
        return true;
      }
      if (url.pathname.startsWith(`${prefix}assets/`) && request.method === 'GET') {
        const file = resolve(assets, decodeURIComponent(url.pathname.slice(`${prefix}assets/`.length)));
        if (!file.startsWith(assets + sep)) { response.writeHead(403).end(); return true; }
        try {
          response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          response.writeHead(404).end('Legacy asset not found.');
        }
        return true;
      }
      const id = url.searchParams.get('session');
      const session = sessions.get(id);
      if (!session) { response.writeHead(404).end('Legacy session not found. Reload the view.'); return true; }
      if (url.pathname === `${prefix}bridge.js` && request.method === 'GET') {
        const config = JSON.stringify({ session: id, prefix });
        response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(`${theme}\n(${browserBridge.toString()})(${config});\n`);
      } else if (url.pathname === `${prefix}host` && request.method === 'POST') {
        const message = await readJson(request);
        const messages = await session.receive(message);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ messages }));
      } else if (url.pathname === `${prefix}close` && request.method === 'POST') {
        await session.close();
        sessions.delete(id);
        response.writeHead(204).end();
      } else {
        response.writeHead(404).end('Legacy route not found.');
      }
      return true;
    },
    async close() {
      await Promise.all([...sessions.values()].map(session => session.close()));
      sessions.clear();
    },
  };
}

class LegacySession {
  constructor(native, openRequest, record, directory, inputs) {
    this.native = native;
    this.openRequest = openRequest;
    this.record = record;
    this.directory = directory;
    this.inputs = inputs;
    this.snapshot = '';
    this.queue = Promise.resolve();
    this.barrier = undefined;
    this.closed = false;
  }

  async receive(message) {
    await this.record({ kind: 'renderer-message', message });
    if (message.type === 'liveSettled') {
      const barrier = this.barrier;
      if (!barrier || message.snapshot_id !== barrier.snapshot) return [];
      this.barrier = undefined;
      clearTimeout(barrier.timer);
      barrier.resolve();
      return barrier.action ? [{ id: 'disclosureDone', body: { ...barrier.action, error: message.error ?? null } }] : [];
    }
    if (message.type === 'webviewReady' || message.type === 'refreshHistory') {
      return this.serial(async () => {
        const body = await this.native.send({ OpenLivePaged: this.openRequest }, 0);
        this.snapshot = body.Ok?.snapshot_id ?? '';
        return [{ id: 'open', body }, ...(this.snapshot ? [{ id: 'ready', body: { Ok: {} } }] : [])];
      });
    }
    if (message.type === 'toggleDisclosure') {
      const action = { key: message.key, task: message.task === true };
      return this.serial(async () => {
        const body = await this.native.send({ ToggleLive: { snapshot_id: this.snapshot, ...action } });
        return this.publish(body, 'disclosure', action);
      });
    }
    if (message.type === 'liveViewport') {
      return this.serial(async () => {
        if (message.viewport?.snapshot_id !== this.snapshot) return [];
        return this.publish(await this.native.send({ ViewportLive: message.viewport }), 'delta');
      });
    }
    if (message.type === 'openJson' || message.type === 'openDiff') return this.open(message);
    const keys = Object.keys(message.body ?? {});
    if (typeof message.id !== 'number' || keys.length !== 1 || !readRequests.has(keys[0])) return [];
    if (keys[0] === 'FindInHistory') {
      return this.serial(async () => {
        const body = await this.native.send(message.body);
        return body.Ok?.live ? this.publish({ Ok: body.Ok.live }, 'delta') : [{ id: message.id, body }];
      });
    }
    return [{ id: message.id, body: await this.native.send(message.body) }];
  }

  serial(operation) {
    // Release HTTP replies before waiting for the renderer to acknowledge a revision.
    return new Promise((resolveResult, rejectResult) => {
      this.queue = this.queue.then(async () => {
        try {
          if (this.closed) throw new Error('Legacy session is closed.');
          resolveResult(await operation());
          if (this.barrier) await this.barrier.promise;
        } catch (error) { rejectResult(error); }
      });
    });
  }

  publish(body, id, action) {
    const latest = body.Ok?.deltas?.at(-1);
    if (!latest) {
      if (body.Error) return action
        ? [{ id: 'disclosureDone', body: { ...action, error: body.Error } }]
        : [{ id, body }];
      return action ? [{ id: 'disclosureDone', body: { ...action, error: null } }] : [];
    }
    this.snapshot = latest.snapshot_id;
    let resolveBarrier;
    const promise = new Promise(resolve => { resolveBarrier = resolve; });
    const barrier = { snapshot: this.snapshot, action, promise, resolve: resolveBarrier };
    barrier.timer = setTimeout(() => {
      if (this.barrier === barrier) this.barrier = undefined;
      void this.record({ kind: 'error', message: 'Legacy renderer did not acknowledge its native revision.', snapshot: barrier.snapshot });
      barrier.resolve();
    }, 120_000);
    this.barrier = barrier;
    return [{ id, body }];
  }

  async open(message) {
    const snapshot = message.snapshot_id;
    const body = message.type === 'openDiff'
      ? { GetFileDiff: { snapshot_id: snapshot, change: message.change } }
      : message.git_oid
        ? { ResolveObject: { snapshot_id: snapshot, repository: message.repository, oid: message.git_oid } }
        : { GetNodeDetails: { snapshot_id: snapshot, op_id: message.op_id } };
    let result = await this.native.send(body);
    if (message.type === 'openDiff' && result.Error?.code === 'stale_snapshot' && snapshot !== this.snapshot) {
      result = await this.native.send({ GetFileDiff: { snapshot_id: this.snapshot, change: message.change } });
    }
    await this.record({ kind: 'editor.open', command: message.type === 'openDiff' ? 'vscode.diff' : 'vscode.open', action: message, result });
    return [{ harnessOpen: { action: message, result } }];
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.barrier) { clearTimeout(this.barrier.timer); this.barrier.resolve(); this.barrier = undefined; }
    this.closing = (async () => {
      await this.native.close();
      const after = await rawManifest(this.directory);
      const unchanged = after.count === this.inputs.count && after.digest === this.inputs.digest;
      await this.record({ kind: 'inputs.check', unchanged,
        before: { count: this.inputs.count, digest: this.inputs.digest },
        after: { count: after.count, digest: after.digest } });
      if (!unchanged) throw new Error('Legacy session changed its raw recorded files.');
    })();
    return this.closing;
  }
}

function nativeService(binary, directory, record) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let next = 0;
  let failure;
  let exited;
  const completion = new Promise(resolve => { exited = resolve; });
  const fail = error => {
    failure = error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', (code, signal) => { fail(new Error(`Legacy service stopped (${signal ?? code}).`)); exited(); });
  child.stderr.on('data', bytes => appendFileSync(join(directory, 'service-stderr.log'), bytes));
  child.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 128 * 1024 * 1024) { fail(new Error('Legacy service frame exceeds 128 MiB.')); child.kill(); return; }
      if (buffer.length < length + 4) break;
      try {
        const response = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        const request = pending.get(response.id);
        if (request) { pending.delete(response.id); clearTimeout(request.timer); request.resolve(response); }
      } catch (error) { fail(error); child.kill(); return; }
    }
  });
  return {
    async send(body, timeout = 120_000) {
      if (failure) throw failure;
      const request = { id: ++next, body };
      const response = await new Promise((resolve, reject) => {
        const timer = timeout ? setTimeout(() => { pending.delete(request.id); reject(new Error(`Legacy ${Object.keys(body)[0]} timed out.`)); }, timeout) : undefined;
        pending.set(request.id, { resolve, reject, timer });
        const bytes = Buffer.from(JSON.stringify(request));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(bytes.length);
        child.stdin.write(Buffer.concat([header, bytes]));
      });
      await record({ kind: 'native', request, response });
      return response.body;
    },
    async close() { child.kill(); await completion; },
  };
}

function browserBridge({ session, prefix: route }) {
  let state;
  let closed = false;
  window.__activityCompareLegacy = { session, pending: 0, lastOpen: null };
  window.vscode = {
    getState: () => state,
    setState: value => { state = value; return value; },
    postMessage(message) {
      window.__activityCompareLegacy.pending += 1;
      return fetch(`${route}host?session=${session}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) })
        .then(async response => {
          if (!response.ok) throw new Error(await response.text());
          for (const reply of (await response.json()).messages) {
            if (reply.harnessOpen) {
              window.__activityCompareLegacy.lastOpen = reply.harnessOpen;
              const detail = { side: 'legacy', session, ...reply.harnessOpen };
              window.dispatchEvent(new CustomEvent('activity-compare-open', { detail }));
              window.parent.postMessage({ type: 'activity-compare-open', ...detail }, location.origin);
            } else window.dispatchEvent(new MessageEvent('message', { data: reply }));
          }
        }).catch(error => {
          if (closed) return;
          window.__activityCompareLegacy.lastError = String(error);
          console.error('Legacy harness bridge:', error);
          window.dispatchEvent(new MessageEvent('message', { data: { id: message.id ?? 'open', body: { Error: String(error) } } }));
        }).finally(() => { window.__activityCompareLegacy.pending -= 1; });
    },
  };
  window.acquireVsCodeApi = () => window.vscode;
  window.addEventListener('pagehide', () => {
    closed = true;
    navigator.sendBeacon(`${route}close?session=${session}`, '');
  }, { once: true });
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error('Legacy browser message exceeds 1 MiB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
