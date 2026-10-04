const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, cpSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const binary = process.env.VSCODE_BIN;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set VSCODE_BIN to an absolute desktop VS Code executable.');
const executable = realpathSync(binary);
const desktop = path.basename(path.dirname(executable)) === 'bin' ? path.resolve(path.dirname(executable), '..', 'code') : executable;
const root = path.resolve(__dirname, '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'idle-installed-vscode-'));
const workspace = path.join(temporary, 'workspace');
const driver = path.join(temporary, 'driver');
const report = path.join(temporary, 'result.json');
const env = { ...process.env, IDLE_TEST_ROOT: workspace, IDLE_TEST_REPORT: report };
for (const key of ['VSCODE_IPC_HOOK_CLI', 'VSCODE_CWD', 'VSCODE_PID', 'ELECTRON_RUN_AS_NODE']) delete env[key];
const profile = ['--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', path.join(temporary, 'extensions'),
  '--shared-data-dir', path.join(temporary, 'shared')];
try {
  mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  mkdirSync(driver);
  writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'idle.chainDirectory': 'chain', 'idle.live.enabled': false, 'idle.tracking.enabled': true,
    'idle.decorations.enabled': true, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  }));
  writeFileSync(path.join(workspace, 'capture.txt'), 'before opening Idle\n');
  writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'idle-assembly-test-driver', publisher: 'idle-tests', version: '0.0.1',
    engines: { vscode: '^1.85.0' }, main: './main.cjs', activationEvents: ['onStartupFinished'] }));
  cpSync(path.join(root, 'test/vscode/assembly.cjs'), path.join(driver, 'test.cjs'));
  // VS Code's extension-test mode uses in-memory mementos. A normal development
  // driver exercises the installed extension with persistent profile storage.
  writeFileSync(path.join(driver, 'main.cjs'), `
const vscode = require('vscode');
const fs = require('node:fs/promises');
exports.activate = async () => {
  try { await require('./test.cjs').run(); }
  catch (error) {
    console.error(error);
    await fs.writeFile(process.env.IDLE_TEST_REPORT, JSON.stringify({ passed: false, error: String(error.stack ?? error) }));
  } finally { await vscode.commands.executeCommand('workbench.action.quit'); }
};
`);
  execFileSync('cargo', ['run', '--quiet', '--locked', '-p', 'idle-vscode-native', '--example', 'history-fixture', '--', workspace], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['init', '-b', 'main', workspace], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'add', 'capture.txt']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Installed fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  execFileSync(binary, [...profile, '--install-extension', path.resolve(process.argv[2] ?? 'idle.vsix'), '--force', '--no-sandbox'], { env, stdio: 'inherit', timeout: 120_000 });
  for (const phase of ['capture', 'restore']) {
    rmSync(report, { force: true });
    execFileSync('xvfb-run', ['-a', desktop, ...profile, '--no-sandbox', '--disable-gpu', '--disable-workspace-trust',
      '--skip-welcome', '--skip-release-notes', '--extensionDevelopmentPath=' + driver, workspace],
    { env: { ...env, IDLE_TEST_PHASE: phase }, stdio: 'inherit', timeout: 180_000 });
    const completed = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(completed.passed, true, completed.error ?? `${phase} completed`);
  }
  const result = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(result.passed, true);
  assert.equal(result.restarted, true);
  console.log(`PASS: installed VSIX in VS Code ${result.version}; repository/session reads, exact record/file/diff opens, capture across view closure, and session/draft recovery after process restart.`);
} catch (error) {
  const logs = path.join(temporary, 'profile', 'logs');
  if (existsSync(logs)) {
    const destination = path.join(root, 'outputs', 'vscode-smoke-failure');
    mkdirSync(destination, { recursive: true });
    cpSync(logs, destination, { recursive: true });
  }
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
