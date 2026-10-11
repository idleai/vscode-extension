'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = process.env.IDLE_COMPUTE_TEST_DIR;
const binary = process.env.VSCODE_BIN;
assert.ok(directory && path.isAbsolute(directory), 'set IDLE_COMPUTE_TEST_DIR to a private test directory');
assert.ok(binary && path.isAbsolute(binary), 'set VSCODE_BIN to desktop VS Code');
const profile = ['--user-data-dir', path.join(directory, 'profile'), '--extensions-dir', path.join(directory, 'extensions'),
  '--shared-data-dir', path.join(directory, 'shared'), '--password-store=basic'];
const env = { ...process.env };
for (const key of ['VSCODE_IPC_HOOK_CLI', 'VSCODE_CWD', 'VSCODE_PID', 'ELECTRON_RUN_AS_NODE']) delete env[key];

async function desktop(phase) {
  const executable = await fs.realpath(binary);
  const app = path.basename(path.dirname(executable)) === 'bin' ? path.resolve(path.dirname(executable), '..', 'code') : executable;
  await fs.rm(path.join(directory, `${phase}.json`), { force: true });
  await exec('xvfb-run', ['-a', app, ...profile, '--no-sandbox', '--disable-gpu', '--disable-workspace-trust',
    '--skip-welcome', '--skip-release-notes', '--extensionDevelopmentPath=' + path.join(directory, 'driver'),
    path.join(directory, 'workspace')], { env: { ...env, IDLE_TEST_PHASE: phase }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(await fs.readFile(path.join(directory, `${phase}.json`), 'utf8'));
  assert.equal(result.passed, true, result.error ?? `desktop ${phase} completed`);
  console.log(`PASS: desktop VS Code ${result.version}, ${phase}`);
}

async function prepare() {
  await fs.mkdir(directory, { mode: 0o700 });
  for (const child of ['driver', 'request', 'workspace/.vscode', 'workspace/chain']) {
    await fs.mkdir(path.join(directory, child), { recursive: true });
  }
  await fs.writeFile(path.join(directory, 'workspace/.vscode/settings.json'), JSON.stringify({
    'idle.chainDirectory': 'chain', 'idle.live.enabled': false, 'idle.tracking.enabled': false,
    'idle.decorations.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  }));
  await exec('git', ['init', '-b', 'main', path.join(directory, 'workspace')]);
  await fs.writeFile(path.join(directory, 'driver/package.json'), JSON.stringify({
    name: 'idle-compute-test-driver', publisher: 'idle-tests', version: '0.0.1', engines: { vscode: '^1.85.0' },
    main: './main.cjs', activationEvents: ['onStartupFinished'],
  }));
  await fs.copyFile(path.join(__dirname, '../test/vscode/compute.cjs'), path.join(directory, 'driver/test.cjs'));
  await fs.writeFile(path.join(directory, 'driver/main.cjs'), `
const vscode = require('vscode');
exports.activate = async () => {
  try { await require('./test.cjs').run(); }
  catch (error) { await require('node:fs/promises').writeFile(require('node:path').join(process.env.IDLE_COMPUTE_TEST_DIR,
    process.env.IDLE_TEST_PHASE + '.json'), JSON.stringify({ passed: false,
      error: error instanceof require('node:assert').AssertionError ? error.message : 'Desktop compute operation failed' })); }
  finally { await vscode.commands.executeCommand('workbench.action.quit'); }
};
`);
  execFileSync(binary, [...profile, '--install-extension', path.resolve(process.argv[3] ?? 'idle.vsix'), '--force', '--no-sandbox'],
    { env, stdio: 'inherit', timeout: 120_000 });
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await fs.writeFile(path.join(directory, 'private-key.pem'), keys.privateKey, { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'request/public-key.pem'), keys.publicKey);
  await desktop('prepare');
  await fs.cp(path.join(directory, 'workspace/.idle/workspace'), path.join(directory, 'request/definitions'), { recursive: true });
}

async function run() {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/);
  assert.match(runId ?? '', /^\d+$/);
  console.log('Waiting for the compute owner to return an encrypted invitation.');
  let encrypted;
  for (let attempt = 0; attempt < 120 && !encrypted; attempt++) {
    try {
      const response = await exec('gh', ['api', `repos/${repository}/contents/invitation.json?ref=acceptance/compute-channel-${runId}`],
        { timeout: 20_000, maxBuffer: 128 * 1024 });
      encrypted = JSON.parse(Buffer.from(JSON.parse(response.stdout).content, 'base64').toString('utf8'));
    } catch { await pause(10_000); }
  }
  assert.ok(encrypted, 'the owner returned the test invitation within twenty minutes');
  const key = crypto.privateDecrypt({ key: await fs.readFile(path.join(directory, 'private-key.pem')),
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(encrypted.key, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const invitation = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]);
  await fs.writeFile(path.join(directory, 'invitation.txt'), invitation, { mode: 0o600 });
  await desktop('connect');
  await fs.rm(path.join(directory, 'invitation.txt'));
  console.log('Desktop closed; reconnect will use VS Code secret storage.');
  await pause(30_000);
  await desktop('restore');
}

(process.argv[2] === 'prepare' ? prepare()
  : ['connect', 'restore'].includes(process.argv[2]) ? desktop(process.argv[2]) : run()).catch(error => {
  console.error(error instanceof assert.AssertionError ? error.message : 'Desktop compute acceptance failed.');
  process.exitCode = 1;
});
