import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Fixture contains a non-regular entry: ${name}`);
  }
  return result.sort();
}

export async function rawManifest(workspace) {
  const root = join(workspace, '.editchain');
  const names = (await files(root)).filter(name => name.endsWith('.eclog') || name.startsWith(`blobs${sep}`));
  const records = [];
  for (const name of names) records.push({ name, sha256: sha256(await readFile(join(root, name))) });
  return { count: records.length, digest: sha256(JSON.stringify(records)), records };
}

export async function prepareWorkspaces(source, runDirectory) {
  const original = await rawManifest(source);
  assert(original.count > 0, 'The source must contain recorded .editchain logs and blobs.');
  const head = git(source, 'rev-parse', 'HEAD');
  const refs = git(source, 'show-ref');
  const workspaces = {};
  for (const side of ['legacy', 'current']) {
    const destination = join(runDirectory, side, 'workspace');
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true, filter: path => {
      const first = relative(source, path).split(sep)[0];
      return !['.editchain', '.editchain-empty', 'node_modules', 'target', 'out', 'dist', 'outputs'].includes(first);
    } });
    for (const { name } of original.records) {
      const target = join(destination, '.editchain', name);
      await mkdir(join(target, '..'), { recursive: true });
      await cp(join(source, '.editchain', name), target);
    }
    await mkdir(join(destination, '.editchain-empty'), { recursive: true });
    assert.deepEqual(await rawManifest(destination), original, `${side} raw input matches`);
    assert.equal(git(destination, 'rev-parse', 'HEAD'), head);
    assert.equal(git(destination, 'show-ref'), refs);
    workspaces[side] = destination;
  }
  const manifest = { source, head, refs, ...original };
  await writeFile(join(runDirectory, 'inputs.json'), JSON.stringify(manifest, null, 2));
  return { workspaces, manifest };
}
