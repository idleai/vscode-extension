'use strict';

// Explicit live test: owns a temporary daemon, workspace and Dev Tunnel.
// Invitations stay in private files and VS Code's mocked secret store.
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fixture, loadWithVSCode } = require('../test/helpers/vscode.cjs');
const { CoordinationProbe } = require('./smoke-coordination-owner.cjs');

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const required = name => {
  const value = process.env[name];
  assert.ok(value && path.isAbsolute(value), `${name} must name an absolute executable`);
  return value;
};
const codex = required('IDLE_CODEX_BIN');
const helper = required('IDLE_RUNTIME_HOST_BIN');
const github = required('IDLE_GITHUB_CLI');

async function until(operation, description, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await operation()) return;
    await pause(500);
  }
  throw new Error(`Timed out: ${description}`);
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-compute-'));
  const home = path.join(directory, 'codex');
  const checkout = path.join(directory, 'checkout');
  const chain = path.join(directory, 'chain');
  const socket = path.join(directory, 'daemon.sock');
  await Promise.all([home, checkout, chain].map(value => fs.mkdir(value, { mode: 0o700 })));
  const env = { ...process.env, CODEX_HOME: home };
  let daemon, hosted = false, clean = false;
  const f = fixture();
  const { NativeHost } = loadWithVSCode('../../out/host/nativeHost', f.api);
  const { RuntimeHost } = loadWithVSCode('../../out/host/runtime', f.api);
  const native = new NativeHost(() => helper);
  const runtime = new RuntimeHost(f.context, { assertTrusted() {} }, native, () => coordination.contributor());
  const binding = { workspace_id: 'live-workspace', repository_id: 'live-repository', chain: 'live-chain' };
  const coordination = new CoordinationProbe(f, native, runtime, binding, directory);
  const config = coordination.config;
  const owner = args => exec(codex, ['app-server', 'idle', '--socket-path', socket, ...args], {
    env, timeout: 70_000, maxBuffer: 1024 * 1024,
  });
  const start = async () => {
    daemon = spawn(codex, ['app-server', '--listen', `unix://${socket}`, '--managed-daemon',
      '-c', 'features.plugin_startup_tasks=false'], { env, stdio: 'ignore' });
    await until(async () => {
      assert.equal(daemon.exitCode, null, 'temporary daemon exited during startup');
      try { await owner(['status']); return true; } catch { return false; }
    }, 'temporary daemon startup');
  };
  const stop = async () => {
    if (!daemon || daemon.exitCode !== null) return;
    daemon.kill('SIGTERM');
    await until(async () => daemon.exitCode !== null || daemon.signalCode !== null, 'temporary daemon shutdown', 80);
  };
  try {
    await coordination.prepare(checkout);
    await start();
    const requestPath = path.join(directory, 'request.json');
    const invitationPath = path.join(directory, 'invitation.txt');
    await fs.writeFile(requestPath, await runtime.connectionRequest(binding), { mode: 0o600 });
    hosted = true;
    await owner(['host', '--request', requestPath, '--checkout-root', checkout, '--chain-directory', chain,
      '--relay-helper', helper, '--github-cli', github, '--output', invitationPath, '--hours', '1']);
    const invitation = (await fs.readFile(invitationPath, 'utf8')).trim();
    let grant = JSON.parse(Buffer.from(invitation.slice('idle-runtime:'.length), 'base64url').toString());
    await runtime.connect(config, binding, invitation);
    const first = await runtime.snapshot(config, binding);
    assert.ok(first.connected && first.status.workspaces[0].available, 'extension must read live daemon status');
    assert.equal(first.status.hostId, grant.hostId);
    console.log('PASS: VS Code runtime adapter connected through Dev Tunnels');
    await assert.rejects(runtime.coordination(config, binding, '{"kind":"status"}'), { code: 'denied' });
    const ownerInvitationPath = path.join(directory, 'owner-invitation.txt');
    await owner(['host', '--request', requestPath, '--checkout-root', checkout, '--chain-directory', chain,
      '--relay-helper', helper, '--github-cli', github, '--output', ownerInvitationPath, '--hours', '1', '--coordination-owner']);
    const ownerInvitation = (await fs.readFile(ownerInvitationPath, 'utf8')).trim();
    grant = JSON.parse(Buffer.from(ownerInvitation.slice('idle-runtime:'.length), 'base64url').toString());
    assert.equal(grant.version, 2);
    await runtime.connect(config, binding, ownerInvitation);
    await coordination.transfer();
    coordination.reset();
    await runtime.reset();
    assert.ok((await runtime.snapshot(config, binding)).connected, 'saved invitation must reconnect after client reset');
    console.log('PASS: closing the client leaves the daemon and workspace running');
    await coordination.verify();
    coordination.reset();
    await runtime.reset();
    await stop();
    await start();
    await until(async () => {
      await runtime.reset();
      const current = await runtime.snapshot(config, binding);
      return current?.connected;
    }, 'runtime reconnect after daemon restart', 8);
    const restarted = await runtime.snapshot(config, binding);
    assert.equal(restarted.status.hostId, first.status.hostId);
    assert.notEqual(restarted.status.runtimeId, first.status.runtimeId);
    await coordination.verify();
    console.log('PASS: daemon restart preserves host identity and grants');
    await owner(['revoke', '--grant-id', grant.grantId]);
    await coordination.verifyDenied();
    await runtime.reset();
    const revoked = await runtime.snapshot(config, binding);
    assert.ok(revoked && !revoked.connected, 'revoked invitation must be shown as unavailable');
    console.log('PASS: revoked grant denies reconnect and retains an unavailable host row');
    await owner(['stop']);
    clean = true;
  } finally {
    await coordination.shutdown();
    await runtime.shutdown();
    await native.shutdown();
    if (hosted && !clean) {
      try { await owner(['stop']); clean = true; }
      catch { console.error(`Relay cleanup needs retry using the private state at ${home}`); }
    }
    await stop();
    if (clean || !hosted) await fs.rm(directory, { recursive: true, force: true });
    else console.error(`Retained test state: ${directory}`);
  }
}

main().catch(error => {
  // Child-process errors may contain private stdout. Print only a controlled summary.
  console.error(error instanceof assert.AssertionError || error.message?.startsWith('Timed out:')
    ? error.message : 'Compute connection test failed; inspect the affected step.');
  process.exitCode = 1;
});
