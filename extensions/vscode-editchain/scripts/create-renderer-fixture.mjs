import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Give the real VS Code renderer a fixed, scrollable Git and agent history.
// A source checkout's commit count changes with repository extraction and depth.
const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(extension, '../..');
if (!process.argv[2]) throw new Error('Pass a new fixture directory.');
const workspace = path.resolve(process.argv[2]);
fs.mkdirSync(workspace);
execFileSync('git', ['init', '-q', workspace]);
for (let revision = 0; revision < 40; revision++) {
  fs.writeFileSync(path.join(workspace, 'README.md'), `Renderer fixture revision ${revision}\n`);
  fs.writeFileSync(path.join(workspace, 'r10-renderer-fixture.txt'), `Recorded revision ${revision}\n`);
  execFileSync('git', ['-C', workspace, 'add', 'README.md', 'r10-renderer-fixture.txt']);
  const date = new Date(Date.UTC(2026, 8, 1) + revision * 60_000).toISOString();
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Renderer Fixture',
    '-c', 'user.email=renderer@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-qm', `Renderer fixture ${revision}`],
  { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}
const executable = `editchain-legacy${process.platform === 'win32' ? '.exe' : ''}`;
execFileSync(path.join(repository, 'target/release', executable), ['import',
  '--provider', 'claude', '--sessions-dir', path.join(extension, 'test/fixtures/claude'),
  '--workspace', workspace, '--chain', path.join(workspace, '.editchain')],
{ stdio: 'inherit' });
