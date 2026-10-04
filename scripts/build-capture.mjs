import { execFileSync } from 'node:child_process';
import { mkdir, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve('../host-tools');
execFileSync('cargo', ['build', '--locked', '--release', '-p', 'idle-editor-capture', '--bin', 'idle-editor-service'], { cwd: source, stdio: 'inherit' });
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { cwd: source, encoding: 'utf8' }));
const name = `idle-editor-service${process.platform === 'win32' ? '.exe' : ''}`;
const directory = path.resolve('bin', `${process.platform}-${process.arch}`);
await mkdir(directory, { recursive: true });
const destination = path.join(directory, name);
await copyFile(path.join(metadata.target_directory, 'release', name), destination);
await chmod(destination, 0o755);
