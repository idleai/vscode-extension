import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createCurrentAdapter } from './current.mjs';
import { createLegacyAdapter } from './legacy.mjs';
import { git, prepareWorkspaces, rawManifest, sha256 } from './fixture.mjs';

const { values } = parseArgs({ options: {
  'legacy-root': { type: 'string' }, 'legacy-service': { type: 'string' },
  'current-root': { type: 'string' }, 'current-revision': { type: 'string' },
  workspace: { type: 'string' }, output: { type: 'string', default: 'outputs/activity-compare/runs' },
  'git-root': { type: 'string' },
  port: { type: 'string', default: '4173' },
} });
for (const key of ['legacy-root', 'legacy-service', 'current-root', 'current-revision', 'workspace']) {
  assert(values[key], `Missing --${key}. See docs/activity-comparison.md.`);
}
const directory = dirname(fileURLToPath(import.meta.url));
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const runDirectory = await mkdtemp(join(output, 'run-'));
const { workspaces, manifest: input } = await prepareWorkspaces(resolve(values.workspace), runDirectory);
const gitRoot = values['git-root'] ? resolve(values['git-root']) : undefined;
const gitSource = gitRoot ? { root: gitRoot, head: git(gitRoot, 'rev-parse', 'HEAD'), refs: git(gitRoot, 'show-ref') } : undefined;
let journal = Promise.resolve();
let sequence = 0;
const recent = [];
function record(event) {
  const entry = { ...event, sequence: ++sequence, time: new Date().toISOString() };
  recent.push(/^(ui\.|editor\.|error|checkpoint)/.test(entry.kind ?? '') ? entry : {
    side: entry.side, kind: entry.kind, sequence: entry.sequence, time: entry.time,
  });
  if (recent.length > 100) recent.shift();
  journal = journal.then(() => appendFile(join(runDirectory, 'events.jsonl'), JSON.stringify(entry) + '\n'));
}
const legacy = await createLegacyAdapter({ legacyRoot: resolve(values['legacy-root']), servicePath: resolve(values['legacy-service']), workspace: workspaces.legacy, gitRoot, runDirectory: join(runDirectory, 'legacy'), record });
const current = await createCurrentAdapter({ currentRoot: resolve(values['current-root']), workspace: workspaces.current, gitRoot, runDirectory: join(runDirectory, 'current'), record });
const manifest = {
  created: new Date().toISOString(), runDirectory,
  input: { source: input.source, head: input.head, rawFiles: input.count, digest: input.digest, gitSource },
  legacy: { revision: git(values['legacy-root'], 'rev-parse', 'HEAD'), serviceSha256: sha256(await readFile(values['legacy-service'])), ...legacy.metadata },
  current: { revision: values['current-revision'], bundleSha256: sha256(await readFile(join(values['current-root'], 'out/extension.js'))),
    rendererSha256: sha256(await readFile(join(values['current-root'], 'dist/pkg/idle_vscode_webview_bg.wasm'))),
    nativeSha256: sha256(await readFile(join(values['current-root'], `bin/${process.platform}-${process.arch}/idle-host${process.platform === 'win32' ? '.exe' : ''}`))),
    ...current.metadata },
  scope: 'Real Activity renderers and native services. VS Code API transport is adapted; editor opens are recorded. No workbench, tracking, or live provider import.',
};
await writeFile(join(runDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']], ['/compare.js', ['compare.js', 'text/javascript']],
  ['/compare.css', ['compare.css', 'text/css']], ['/compare-observer.js', ['observer.js', 'text/javascript']],
  ['/compare-theme.css', ['theme.css', 'text/css']],
]);
const server = createServer(async (request, response) => {
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(request.url, origin);
    response.setHeader('Cache-Control', 'no-store');
    if (request.headers.origin && request.headers.origin !== origin) { response.writeHead(403).end(); return; }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (staticFiles.has(url.pathname)) {
      const [name, type] = staticFiles.get(url.pathname);
      response.setHeader('Content-Type', type);
      response.end(await readFile(join(directory, name)));
    } else if (url.pathname === '/api/manifest') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(manifest));
    } else if (url.pathname === '/api/events' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(recent.filter(entry => entry.sequence > Number(url.searchParams.get('after') ?? 0))));
    } else if (url.pathname === '/api/record' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 2_000_000) throw new Error('Recorded DOM state exceeds 2 MB.');
      }
      const event = JSON.parse(body);
      record(event);
      if (event.kind === 'checkpoint') await writeFile(join(runDirectory, `checkpoint-${sequence}.json`), JSON.stringify(event, null, 2));
      response.writeHead(204).end();
    } else if (!await legacy.handle(request, response, url) && !await current.handle(request, response, url)) {
      response.writeHead(404).end('Not found');
    }
  } catch (error) {
    record({ side: 'harness', kind: 'error', error: String(error) });
    if (!response.headersSent) response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise(done => server.listen(Number(values.port), '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
await writeFile(join(output, 'latest.json'), JSON.stringify({ origin, runDirectory }, null, 2));
console.log(`Activity comparison: ${origin}\nRun files: ${runDirectory}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all([legacy.close(), current.close()]);
  if (gitSource) {
    const after = { root: gitRoot, head: git(gitRoot, 'rev-parse', 'HEAD'), refs: git(gitRoot, 'show-ref') };
    record({ side: 'harness', kind: 'git-source.check', unchanged: JSON.stringify(after) === JSON.stringify(gitSource), after });
    assert.deepEqual(after, gitSource, 'The bound Git source retained its HEAD and refs.');
  }
  for (const [side, workspace] of Object.entries(workspaces)) {
    const result = await rawManifest(workspace);
    record({ side, kind: 'input.check', unchanged: result.digest === input.digest, digest: result.digest });
    assert.equal(result.digest, input.digest, `${side} raw history is unchanged`);
  }
  await journal;
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
process.once('SIGINT', () => close().catch(error => { console.error(error); process.exitCode = 1; }));
process.once('SIGTERM', () => close().catch(error => { console.error(error); process.exitCode = 1; }));
