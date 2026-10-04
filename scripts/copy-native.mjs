import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import artifacts from './native-artifacts.cjs';

export async function copyNative(owner, names) {
  artifacts.install(owner);
  const directory = path.join(artifacts.root, 'bin', `${process.platform}-${process.arch}`);
  await mkdir(directory, { recursive: true });
  for (const name of names) {
    const source = artifacts.binary(owner, name);
    const destination = path.join(directory, path.basename(source));
    await copyFile(source, destination);
    await chmod(destination, 0o755);
  }
}
