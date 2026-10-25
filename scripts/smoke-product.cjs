'use strict';

// Exercise the shipped extension bundle and native host against the packaged
// Codex app server over its local-owner stdio connection.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');

class AppServer {
  constructor(binary, home) {
    this.next = 0;
    this.pending = new Map();
    this.errors = '';
    const command = path.basename(binary) === 'codex' ? ['app-server'] : [];
    this.process = spawn(binary, [...command, '-c', 'features.plugin_startup_tasks=false'], {
      env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.closed = new Promise(resolve => this.process.once('close', resolve));
    this.process.stderr.on('data', data => { this.errors = (this.errors + data).slice(-8000); });
    this.process.on('error', error => this.fail(error));
    this.process.stdin.on('error', error => this.fail(error));
    this.process.on('exit', code => this.fail(new Error(`App server exited (${code}): ${this.errors}`)));
    readline.createInterface({ input: this.process.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('App server emitted invalid JSON')); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else pending.resolve(message.result);
    });
  }

  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  request(method, params) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'idle-product-check', version: '1' },
      capabilities: { experimentalApi: true } });
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  }

  async stop() {
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 20_000);
    try { assert.equal(await this.closed, 0, 'the local app server shut down cleanly'); }
    finally { clearTimeout(timer); }
  }
}

async function main() {
  const installed = process.env.IDLE_PACKAGED_EXTENSION;
  const runtime = process.env.IDLE_CODEX_PACKAGE;
  const source = process.env.IDLE_EXTENSION_SOURCE;
  const variant = process.env.IDLE_CODEX_VARIANT ?? 'codex';
  assert.ok(['codex', 'codex-app-server'].includes(variant));
  for (const directory of [installed, runtime, source]) assert.ok(path.isAbsolute(directory ?? ''));
  const { fixture, loadWithVSCode } = require(path.join(source, 'test/helpers/vscode.cjs'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-product-runtime-'));
  const home = path.join(directory, 'codex');
  const editor = path.join(directory, 'editor');
  const checkout = path.join(directory, 'compute');
  const chain = path.join(directory, 'compute-chain');
  await Promise.all([home, editor, checkout, chain, path.join(editor, 'chain')]
    .map(child => fs.mkdir(child, { recursive: true, mode: 0o700 })));
  const f = fixture();
  const uri = value => f.api.Uri.parse(pathToFileURL(value).toString());
  f.context.extensionUri = uri(installed);
  f.context.globalStorageUri = uri(path.join(directory, 'editor-private'));
  f.api.workspace.workspaceFolders = [{ name: 'Product check', index: 0, uri: uri(editor) }];
  f.configuration.set(uri(editor).toString(), { chainDirectory: 'chain', 'tracking.enabled': false,
    'live.enabled': false, 'decorations.enabled': false });
  const extension = loadWithVSCode(path.join(installed, 'out/extension.js'), f.api);
  const host = extension.activate(f.context);
  const binding = { workspace_id: 'product-workspace', repository_id: 'product-repository', chain: 'product-chain' };
  const config = host.configuration.forResource(uri(editor));
  const rpcBinding = { workspaceId: binding.workspace_id, repositoryId: binding.repository_id,
    checkoutId: 'product-checkout', chainId: binding.chain, checkoutRoot: checkout, chainDirectory: chain };
  let server;
  const start = async () => {
    server = new AppServer(path.join(runtime, 'bin', variant), home);
    await server.initialize();
  };
  const read = async command => {
    const response = await host.coordination.read(config, binding, { command: JSON.stringify(command), drafts: '[]' },
      { signal: new AbortController().signal, session: 'product-check' });
    const parsed = JSON.parse(response.native);
    assert.ok(Object.hasOwn(parsed.result, 'Ok'), 'the native coordinator accepted the command');
    return parsed.result.Ok;
  };
  const mutation = async (id, value, expected) => {
    const contributor = await host.coordination.contributor();
    return { kind: 'mutate', data: { api_version: '1', control_fence: null,
      context: { workspace_id: binding.workspace_id, request_id: id, expires_at: String(Date.now() + 3600_000),
        contributor: { contributor_id: contributor,
          authenticated_as: { issuer: 'idle-vscode-local', subject: contributor.slice('local-contributor:'.length) } } },
      body: { kind: 'configuration', data: { document: 'Settings',
        change: { expected, value: { schema_version: 1, json: JSON.stringify(value) } } } } } };
  };
  try {
    await read({ kind: 'snapshot' });
    const original = await mutation('before-transfer', { savedBeforeTransfer: true }, { kind: 'absent' });
    const originalResult = await read(original);
    assert.equal(originalResult.result.status, 'success');
    const before = await read({ kind: 'snapshot' });
    await fs.cp(path.join(editor, '.idle'), path.join(checkout, '.idle'), { recursive: true });
    await start();
    await server.request('idle/workspace/attach', { protocolVersion: 1, binding: rpcBinding });
    await server.stop();
    server = undefined;
    // This fixture owns its private installation. Select the real packaged host
    // without creating a cloud tunnel or depending on a user credential.
    const registry = path.join(home, 'idle-runtime/workspaces.json');
    const saved = JSON.parse(await fs.readFile(registry, 'utf8'));
    saved.coordinationHelper = path.join(installed, 'bin/linux-x64/idle-host');
    await fs.writeFile(registry, JSON.stringify(saved), { mode: 0o600 });
    await start();
    const status = async () => (await server.request('idle/runtime/status/read', { protocolVersion: 1 })).status;
    const first = await status();
    assert.equal(first.workspaces[0].available, true);
    // The same packaged coordination implementation can use a local owner
    // transport; remote tunnel lifecycle has its own live acceptance workflow.
    const send = async (_config, _binding, request) => (await server.request('idle/coordination/call', {
      protocolVersion: 1, checkoutId: rpcBinding.checkoutId,
      clientId: await host.coordination.contributor(), request,
    })).response;
    host.runtime.snapshot = async () => ({ connected: true, status: await status(), observed_at: Date.now(), revision: 1 });
    host.runtime.coordination = send;
    let lost = false;
    host.runtime.coordination = async (...args) => {
      const response = await send(...args);
      if (!lost && JSON.parse(args[2]).kind === 'commit') {
        lost = true;
        throw new Error('Product check lost transfer acknowledgement');
      }
      return response;
    };
    await assert.rejects(host.coordination.moveToRuntime(config, binding), /Product check lost transfer acknowledgement/);
    host.runtime.coordination = send;
    host.coordination.reset();
    await host.coordination.moveToRuntime(config, binding);
    assert.deepEqual(await read({ kind: 'snapshot' }), before, 'moving coordination preserves the workspace snapshot');
    const changed = await mutation('after-transfer', { savedOnCompute: true },
      { kind: 'revision', value: before.settings.revision });
    assert.equal((await read(changed)).result.status, 'success');
    assert.deepEqual(await read(original), originalResult, 'a retry keeps the original result after transfer');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(checkout, '.idle/workspace/settings.json'), 'utf8')),
      { savedOnCompute: true });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(editor, '.idle/workspace/settings.json'), 'utf8')),
      { savedBeforeTransfer: true });
    const after = await read({ kind: 'snapshot' });
    await server.stop();
    server = undefined;
    await start();
    host.coordination.reset();
    const restored = await status();
    assert.equal(restored.hostId, first.hostId);
    assert.notEqual(restored.runtimeId, first.runtimeId);
    assert.deepEqual(await read({ kind: 'snapshot' }), after, 'Codex restart restores the same native coordinator');
    await assert.rejects(server.request('idle/runtime/status/read', { protocolVersion: 99 }), { code: -32602 });
    console.log(`PASS: packaged extension → packaged ${variant} → packaged native host; transfer, write routing, retry recovery and daemon restart.`);
  } finally {
    const cleanup = await Promise.allSettled([host.shutdown(), server?.stop()]);
    await fs.rm(directory, { recursive: true, force: true });
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  }
}

main().catch(error => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
