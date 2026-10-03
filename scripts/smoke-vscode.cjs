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
const profile = ['--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', path.join(temporary, 'extensions')];
try {
  mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  mkdirSync(driver);
  writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'idle.chainDirectory': 'chain', 'idle.live.enabled': false, 'idle.tracking.enabled': true,
    'idle.decorations.enabled': true, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  }));
  writeFileSync(path.join(workspace, 'capture.txt'), 'before opening Idle\n');
  writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'idle-assembly-test-driver', publisher: 'idle-tests', version: '0.0.1', engines: { vscode: '^1.85.0' } }));
  execFileSync('cargo', ['run', '--quiet', '--locked', '-p', 'idle-vscode-native', '--example', 'history-fixture', '--', workspace], { cwd: root, stdio: 'inherit' });
  execFileSync(binary, [...profile, '--install-extension', path.resolve(process.argv[2] ?? 'idle.vsix'), '--force', '--no-sandbox'], { env, stdio: 'inherit', timeout: 120_000 });
  execFileSync('xvfb-run', ['-a', desktop, ...profile, '--no-sandbox', '--disable-gpu', '--disable-workspace-trust',
    '--skip-welcome', '--skip-release-notes', '--extensionDevelopmentPath=' + driver,
    '--extensionTestsPath=' + path.join(root, 'test/vscode/assembly.cjs'), workspace], { env, stdio: 'inherit', timeout: 180_000 });
  const result = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(result.passed, true);
  console.log(`PASS: installed VSIX in VS Code ${result.version}; native metadata, exact record/file/diff opens, capture across view closure and reopening.`);
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
