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
    assert.ok(files.includes('extension/dist/peer-state/idle_peer_state_bg.wasm'));
    assert.ok(!files.some(file => file.includes('editchain-vscode-service') || file.includes('editchain_history_renderer') || file.includes('editchain_client_state')));
    const captureBinary = `bin/${process.platform}-${process.arch}/idle-editor-service${process.platform === 'win32' ? '.exe' : ''}`;
    assert.ok(files.includes(`extension/${captureBinary}`));
    const historyBinary = `bin/${process.platform}-${process.arch}/idle-history-service${process.platform === 'win32' ? '.exe' : ''}`;
    assert.ok(files.includes(`extension/${historyBinary}`));
    for (const name of ['idle-history-collector', 'codex-session-exporter', 'editchain-peer', 'idle-coordination', 'idle-repository']) {
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
    assert.equal(typeof host.native.startPeer, 'function');
    assert.equal(typeof host.transport.bridgeDuplex, 'function');
    assert.equal(typeof host.presence.connect, 'function');
    assert.equal(f.commands.has('idle.presence.showPeers'), true);
    const adapters = await host.devTunnels();
    adapters.createClient();
    adapters.createHost({ port: 43187, incoming() {} });
    const { SharedConnection } = createRequire(entry)(path.join(temporary, 'extension/dist/peer-state/idle_peer_state.js'));
    const peerState = new SharedConnection();
    peerState.begin();
    assert.equal(peerState.status, 'Connecting');
    peerState.free();
    await smokeCoordination(host, f, temporary);
    await smokeHistory(host, f, path.join(temporary, 'extension', historyBinary), path.join(temporary, 'extension'));
    await extension.deactivate();
    assert.deepEqual(external, []);
    Module._load = original;
    await smokeCapture(path.join(temporary, 'extension', captureBinary));
    await smokeCollection(path.dirname(path.join(temporary, 'extension', captureBinary)));
    console.log('PASS: isolated VSIX host activation and lazy tunnel SDK loading, with no external runtime packages.');
  } finally {
    await extension?.deactivate();
    for (const disposable of f.context.subscriptions) disposable.dispose();
    Module._load = original;
    rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
