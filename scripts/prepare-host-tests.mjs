import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import artifacts from './native-artifacts.cjs';

artifacts.install('engine', 'host-tools');
const host = artifacts.artifact('host-tools');
const runtime = path.join(host, 'packages/history-runtime');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const args of [['ci'], ['test']]) {
  execFileSync(npm, args, { cwd: runtime, stdio: 'inherit', shell: process.platform === 'win32' });
}
const tests = JSON.parse(readFileSync(path.join(host, 'tests.json'), 'utf8'));
if (tests.length === 0) throw new Error('The host-tools release has no compatibility tests.');
for (const executable of tests) {
  execFileSync(path.join(host, executable), [], {
    cwd: host,
    stdio: 'inherit',
    env: {
      ...process.env,
      IDLE_COORDINATION_TEST_ROOT: host,
      IDLE_COORDINATION_BINARY: artifacts.binary('host-tools', 'idle-coordination'),
      IDLE_ENGINE_PEER: artifacts.binary('engine', 'editchain-peer'),
    },
  });
}
const fixtures = artifacts.artifact('app-core');
mkdirSync(fixtures, { recursive: true });
writeFileSync(path.join(fixtures, 'peer-view.json'), execFileSync('cargo', [
  'run', '--locked', '--quiet', '-p', 'idle-vscode-webview', '--example', 'export-assets', '--', 'peer-view',
], { cwd: artifacts.root }));
await import('./build-native.mjs');
