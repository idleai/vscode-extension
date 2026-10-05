const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { builtinModules, createRequire } = require('node:module');
const Module = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fixture, uri } = require('../test/helpers/vscode.cjs');
const { smokeCapture } = require('./smoke-capture.cjs');
const { smokeHistory } = require('./smoke-history.cjs');
const { smokeCoordination } = require('./smoke-coordination.cjs');
const { smokeCollection } = require('./smoke-collection.cjs');

async function main() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'idle-package-smoke-'));
  const original = Module._load;
  const external = [];
  let extension;
  const f = fixture();
  try {
    const archive = path.resolve(process.argv[2] ?? 'idle.vsix');
    const files = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(files.includes('extension/dist/pkg/idle_vscode_webview_bg.wasm'));
    assert.ok(!files.some(file => file.includes('/dist/peer-state/')), 'sharing runs in the native service');
    assert.ok(!files.some(file => file.includes('editchain-peer') || file.includes('editchain-vscode-service') || file.includes('editchain_history_renderer') || file.includes('editchain_client_state')));
    const hostBinary = `bin/${process.platform}-${process.arch}/idle-host${process.platform === 'win32' ? '.exe' : ''}`;
    assert.equal(files.filter(file => file.startsWith('extension/bin/')).length, 2, 'the VSIX ships one native host and the exporter helper');
    for (const name of ['idle-host', 'codex-session-exporter']) {
      assert.ok(files.includes(`extension/bin/${process.platform}-${process.arch}/${name}${process.platform === 'win32' ? '.exe' : ''}`));
    }
    assert.ok(!files.some(file => file.includes('/node_modules/') || file.includes('/out/host/') || file.endsWith('.map')));
    execFileSync('unzip', ['-q', archive, '-d', temporary]);
    const entry = path.join(temporary, 'extension/out/extension.js');
    f.context.globalStorageUri = uri(pathToFileURL(path.join(temporary, 'private')).toString());
    f.context.extensionUri = uri(pathToFileURL(path.join(temporary, 'extension')).toString());
    Module._load = function(name, ...args) {
      if (name === 'vscode') return f.api;
      if (!name.startsWith(temporary + path.sep) && !builtinModules.includes(name) && !name.startsWith('node:')) {
        external.push(name);
        throw new Error('The VSIX attempted to load an external runtime package.');
      }
      return original.call(this, name, ...args);
    };
    extension = createRequire(entry)(entry);
    const host = extension.activate(f.context);
    assert.equal(f.calls.auth.length, 0);
    assert.equal(typeof host.native.connection, 'function');
    assert.equal(typeof host.transport.bridgeDuplex, 'function');
    assert.equal(typeof host.presence.connect, 'function');
    assert.equal(f.commands.has('idle.presence.showPeers'), true);
    assert.equal(host.devTunnels, undefined, 'no JavaScript tunnel owner remains');
    await smokeCoordination(host, f, temporary);
    await f.commands.get('idle.sharing.request')();
    const request = JSON.parse(Buffer.from(f.calls.clipboard.at(-1).slice('editchain:'.length), 'base64url'));
    assert.equal(request.kind, 'request');
    assert.match(request.device.fingerprint, /^[a-f0-9]{64}$/);
    const sharing = await f.commands.get('idle.sharing.status')();
    assert.equal(sharing.length, 1); assert.equal(sharing[0].enabled, false);
    await f.commands.get('idle.sharing.stop')();
    await smokeHistory(host, f, path.join(temporary, 'extension', hostBinary), path.join(temporary, 'extension'));
    await extension.deactivate();
    assert.deepEqual(external, []);
    Module._load = original;
    await smokeCapture(path.join(temporary, 'extension', hostBinary));
    await smokeCollection(path.dirname(path.join(temporary, 'extension', hostBinary)));
    console.log('PASS: isolated VSIX activation, native sharing commands and private coordinator IPC, with no external runtime packages.');
  } finally {
    await extension?.deactivate();
    for (const disposable of f.context.subscriptions) disposable.dispose();
    Module._load = original;
    rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
