'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const repository = 'idleai/vscode-extension';
const runId = process.argv[2];
assert.match(runId ?? '', /^\d+$/, 'supply the acceptance workflow run ID');
for (const name of ['IDLE_CODEX_BIN', 'IDLE_RUNTIME_HOST_BIN', 'IDLE_GITHUB_CLI']) {
  assert.ok(path.isAbsolute(process.env[name] ?? ''), `${name} must name an absolute executable`);
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-remote-compute-'));
  const home = path.join(directory, 'codex');
  const checkout = path.join(directory, 'checkout');
  const chain = path.join(directory, 'chain');
  const socket = path.join(directory, 'daemon.sock');
  const ref = `acceptance/compute-channel-${runId}`;
  const env = { ...process.env, CODEX_HOME: home };
  const gh = args => exec(process.env.IDLE_GITHUB_CLI, args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  const api = async (endpoint, body) => {
    const args = ['api', `repos/${repository}/${endpoint}`];
    if (body) {
      const file = path.join(directory, 'api-input.json');
      await fs.writeFile(file, JSON.stringify(body), { mode: 0o600 });
      args.push('--method', 'POST', '--input', file);
    }
    return JSON.parse((await gh(args)).stdout);
  };
  const owner = args => exec(process.env.IDLE_CODEX_BIN, ['app-server', 'idle', '--socket-path', socket, ...args],
    { env, timeout: 70_000, maxBuffer: 1024 * 1024 });
  let daemon, runner, runnerGrant, hosted = false, channel = false, cleaned = false;
  try {
    const run = await api(`actions/runs/${runId}`);
    assert.ok(run.head_branch.startsWith('acceptance/compute/'), 'the run explicitly opted into compute acceptance');
    await gh(['run', 'download', runId, '--repo', repository, '--name', 'compute-connection-request',
      '--dir', path.join(directory, 'request')]);
    await Promise.all([home, checkout, chain].map(child => fs.mkdir(child, { mode: 0o700 })));
    await fs.mkdir(path.join(checkout, '.idle'));
    await fs.cp(path.join(directory, 'request/definitions'), path.join(checkout, '.idle/workspace'), { recursive: true });
    if (process.env.IDLE_COMPUTE_RUNNER === '1') {
      runner = await require('./compute-runner-owner.cjs').prepare(home, checkout, chain);
    }
    daemon = spawn(process.env.IDLE_CODEX_BIN, ['app-server', '--listen', `unix://${socket}`, '--managed-daemon',
      '-c', 'features.plugin_startup_tasks=false'], { env, stdio: 'ignore' });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      assert.equal(daemon.exitCode, null, 'temporary compute daemon is running');
      try { await owner(['status']); ready = true; } catch { await pause(500); }
    }
    assert.ok(ready, 'temporary daemon started');
    hosted = true;
    const invitationFile = path.join(directory, 'invitation.txt');
    await owner(['host', '--request', path.join(directory, 'request/request.json'), '--checkout-root', checkout,
      '--chain-directory', chain, '--relay-helper', process.env.IDLE_RUNTIME_HOST_BIN,
      '--github-cli', process.env.IDLE_GITHUB_CLI, '--output', invitationFile, '--hours', '1', '--coordination-owner']);
    let invitation = await fs.readFile(invitationFile);
    const grant = JSON.parse(Buffer.from(invitation.toString().slice('idle-runtime:'.length), 'base64url'));
    if (runner) {
      const runnerFile = path.join(directory, 'runner-invitation.txt');
      await owner(['host', '--request', path.join(directory, 'request/request.json'), '--checkout-root', checkout,
        '--chain-directory', chain, '--relay-helper', process.env.IDLE_RUNTIME_HOST_BIN,
        '--github-cli', process.env.IDLE_GITHUB_CLI, '--output', runnerFile, '--hours', '1', '--runner']);
      const runnerInvitation = await fs.readFile(runnerFile, 'utf8');
      runnerGrant = JSON.parse(Buffer.from(runnerInvitation.slice('idle-runtime:'.length), 'base64url'));
      invitation = Buffer.from(JSON.stringify({ coordination: invitation.toString('utf8'), runner: runnerInvitation, task: runner.task }));
    }
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(invitation), cipher.final()]);
    const encrypted = { key: crypto.publicEncrypt({ key: await fs.readFile(path.join(directory, 'request/public-key.pem')),
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    // This isolated commit contains only ciphertext, with no workflow files.
    const tree = await api('git/trees', { tree: [{ path: 'invitation.json', mode: '100644', type: 'blob', content: JSON.stringify(encrypted) }] });
    const commit = await api('git/commits', { message: `Temporary encrypted compute invitation for run ${runId}`, tree: tree.sha });
    await api('git/refs', { ref: `refs/heads/${ref}`, sha: commit.sha });
    channel = true;
    console.log('Temporary compute host ready; only the test desktop can decrypt its invitation.');
    let completed;
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await api(`actions/runs/${runId}`);
      if (current.status === 'completed') { completed = current; break; }
      assert.equal(daemon.exitCode, null, 'the compute daemon survives desktop exit');
      await pause(15_000);
    }
    assert.equal(completed?.conclusion, 'success', 'the cross-machine desktop workflow passed');
    await gh(['run', 'download', runId, '--repo', repository, '--name', 'compute-results', '--dir', path.join(directory, 'results')]);
    const result = JSON.parse(await fs.readFile(path.join(directory, 'results/restore.json'), 'utf8'));
    assert.equal(result.hostId, grant.hostId, 'the desktop saw this compute host');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(checkout, '.idle/workspace/settings.json'), 'utf8')),
      { savedOnRemoteCompute: true }, 'desktop writes reached the separate compute filesystem');
    await owner(['status']);
    if (runner) {
      await runner.verify(path.join(directory, 'results'), result);
      await owner(['revoke', '--grant-id', runnerGrant.grantId]);
    }
    await owner(['revoke', '--grant-id', grant.grantId]);
    console.log(`PASS: VS Code ${result.version} on a separate machine transferred coordination, wrote only compute files and reconnected after full desktop exit.`);
  } finally {
    if (runner) await runner.close();
    if (hosted) {
      try { await owner(['stop']); cleaned = true; }
      catch { console.error(`Relay cleanup needs retry using the private state at ${home}`); }
    }
    if (daemon?.exitCode === null) {
      daemon.kill('SIGTERM');
      for (let attempt = 0; attempt < 80 && daemon.exitCode === null && daemon.signalCode === null; attempt++) await pause(500);
      assert.ok(daemon.exitCode !== null || daemon.signalCode !== null, 'temporary compute daemon stopped');
    }
    if (channel) await gh(['api', '--method', 'DELETE', `repos/${repository}/git/refs/heads/${ref}`]);
    if (cleaned || !hosted) await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof assert.AssertionError ? error.message
    : 'Cross-machine compute acceptance failed; inspect the workflow result.');
  process.exitCode = 1;
});
