import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface Sources { files: Map<string, string>; titles: string; git: string }

async function stamp(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function text(file: string): Promise<string> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

async function files(root: string, accepts: (name: string) => boolean): Promise<Map<string, string>> {
  const found: { path: string; stamp: string; time: bigint }[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && accepts(entry.name)) {
        const version = await stamp(file);
        if (version) found.push({ path: file, stamp: version, time: BigInt(version.split(':')[2]) });
      }
    }
  }
  found.sort((a, b) => a.time === b.time ? a.path.localeCompare(b.path) : a.time > b.time ? -1 : 1);
  return new Map(found.map(value => [value.path, value.stamp]));
}

async function gitStamp(marker: string): Promise<string> {
  let git = marker;
  const metadata = await fs.stat(git).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return '';
  if (metadata.isFile()) {
    const pointer = (await text(git)).trim();
    if (!pointer.startsWith('gitdir: ')) throw new Error('Invalid Git directory pointer.');
    git = path.resolve(path.dirname(marker), pointer.slice(8));
  }
  const pointer = (await text(path.join(git, 'commondir'))).trim();
  const common = pointer ? path.resolve(git, pointer) : git;
  const refs = await files(path.join(common, 'refs'), name => !name.endsWith('.lock'));
  const fixed = await Promise.all([path.join(git, 'HEAD'), path.join(common, 'packed-refs'), path.join(common, 'shallow')]
    .map(async file => [file, await stamp(file)]));
  return JSON.stringify([...refs, ...fixed].sort());
}

async function workspaceGit(workspace: string): Promise<string> {
  const pending = [workspace];
  const stamps: [string, string][] = [];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const marker = entries.find(entry => entry.name === '.git');
    if (marker) {
      const file = path.join(directory, marker.name);
      stamps.push([file, await gitStamp(file)]);
    } else if (entries.some(entry => entry.name === 'HEAD' && entry.isFile()) &&
      entries.some(entry => entry.name === 'objects' && entry.isDirectory()) &&
      entries.some(entry => entry.name === 'refs' && entry.isDirectory())) {
      stamps.push([directory, await gitStamp(directory)]);
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !['target', 'node_modules'].includes(entry.name)) {
        pending.push(path.join(directory, entry.name));
      }
    }
  }
  return JSON.stringify(stamps.sort(([left], [right]) => left.localeCompare(right)));
}

/** Discover changes without depending on editor watcher exclusions. */
export async function captureSources(workspace: string, sessions: string, importing: boolean): Promise<Sources> {
  const [rollouts, git, titles] = await Promise.all([
    importing ? files(sessions, name => name.startsWith('rollout-') && name.endsWith('.jsonl')) : new Map<string, string>(),
    workspaceGit(workspace),
    importing ? stamp(path.join(sessions, 'session_index.jsonl')).then(async value => value ||
      (path.basename(sessions) === 'sessions' ? stamp(path.join(sessions, '..', 'session_index.jsonl')) : '')) : '',
  ]);
  return { files: rollouts, git, titles };
}

/** The native importer rechecks the projected cwd before committing any source. */
export async function belongsToWorkspace(file: string, workspace: string): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
    let value;
    try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]); }
    catch { return true; }
    if (value.type !== 'session_meta' || typeof value.payload?.cwd !== 'string' || !path.isAbsolute(value.payload.cwd)) return true;
    const cwd = await fs.realpath(value.payload.cwd).catch(() => path.resolve(value.payload.cwd));
    const root = await fs.realpath(workspace);
    const relative = path.relative(root, cwd);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  } finally { await handle.close(); }
}
