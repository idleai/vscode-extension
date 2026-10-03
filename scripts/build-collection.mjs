import { execFileSync } from 'node:child_process';
import { mkdir, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve('bin', `${process.platform}-${process.arch}`);
await mkdir(directory, { recursive: true });
for (const [manifest, binary, crate] of [
  ['Cargo.toml', 'idle-history-collector', 'idle-history-collector'],
  ['../codex/tools/codex-session-exporter/Cargo.toml', 'codex-session-exporter', undefined],
]) {
  const source = path.resolve(manifest);
  const args = ['build', '--manifest-path', source, '--locked', '--release', '--bin', binary];
  if (crate) args.push('-p', crate);
  execFileSync('cargo', args, { stdio: 'inherit' });
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', source, '--locked', '--no-deps', '--format-version', '1'], { encoding: 'utf8' }));
  const name = `${binary}${process.platform === 'win32' ? '.exe' : ''}`;
  const destination = path.join(directory, name);
  await copyFile(path.join(metadata.target_directory, 'release', name), destination);
  await chmod(destination, 0o755);
}
