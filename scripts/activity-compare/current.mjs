import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { fixture, view, loadWithVSCode } = require('../../test/helpers/vscode.cjs');

export async function createCurrentAdapter({ currentRoot, workspace, gitRoot = workspace, runDirectory, record }) {
  const f = fixture();
  const uri = f.api.Uri.parse(pathToFileURL(gitRoot).toString());
  f.context.extensionUri = f.api.Uri.parse(pathToFileURL(currentRoot).toString());
  f.context.globalStorageUri = f.api.Uri.parse(pathToFileURL(join(runDirectory, 'private')).toString());
  f.api.workspace.workspaceFolders = [{ name: 'Frozen history', index: 0, uri }];
  f.configuration.set(uri.toString(), { chainDirectory: join(workspace, '.editchain'), 'tracking.enabled': false, 'live.enabled': false });
  f.api.authentication.session = undefined;
  const sessions = new Map();
  const openedDirectory = join(runDirectory, 'opened');
  await mkdir(openedDirectory, { recursive: true });
  const execute = f.api.commands.executeCommand;
  f.api.commands.executeCommand = async (id, ...args) => {
    const files = [];
    if (id === 'vscode.open' || id === 'vscode.diff') {
      for (const [index, target] of args.slice(0, id === 'vscode.diff' ? 2 : 1).entries()) {
        const provider = f.calls.contentProviders.find(item => item.scheme === target?.scheme)?.provider;
        if (provider) {
          const content = await provider.provideTextDocumentContent(target);
          const file = join(openedDirectory, `${randomUUID()}-${index}.txt`);
          await writeFile(file, content);
          files.push({ uri: target.toString(), file, characters: content.length });
        }
      }
    }
    record({ side: 'current', kind: 'editor.open', command: id, args, files });
    return execute(id, ...args);
  };
  const extension = loadWithVSCode(join(currentRoot, 'out/extension.js'), f.api);
  const host = extension.activate(f.context);
  const provider = f.calls.providers.find(item => item.id === 'idle.activity')?.provider;
  if (typeof provider?.mount !== 'function') throw new Error('The packaged Activity view provider does not expose its mount method.');
  let pageNumber = 0;
  const assetRoot = join(currentRoot, 'dist');

  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/current/')) return false;
    if (url.pathname === '/current/') {
      const mounted = view('idle.detail');
      mounted.webview.cspSource = url.origin;
      mounted.webview.asWebviewUri = value => ({ toString: () => `${url.origin}/current/assets/${value.fsPath.slice(assetRoot.length + 1)}` });
      const page = { mounted, pending: [], stream: undefined, number: ++pageNumber };
      mounted.webview.postMessage = async message => {
        record({ side: 'current', kind: 'host.reply', page: page.number, message });
        if (page.stream) page.stream.write(`data: ${JSON.stringify(message)}\n\n`);
        else page.pending.push(message);
        return true;
      };
      provider.mount(mounted, 'detail', 'Activity');
      const session = mounted.webview.html.match(/data-host-session="([^"]+)"/)[1];
      sessions.set(session, page);
      const html = mounted.webview.html
        .replace('</head>', '<link rel="stylesheet" href="/compare-theme.css"></head>')
        .replace('<script nonce=', '<script src="/current/bridge.js"></script><script src="/compare-observer.js"></script><script nonce=');
      response.setHeader('Content-Type', 'text/html');
      response.end(html);
    } else if (url.pathname === '/current/events') {
      const page = sessions.get(url.searchParams.get('session'));
      if (!page) { response.writeHead(404).end(); return true; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      page.stream?.end();
      page.stream = response;
      response.write(': connected\n\n');
      for (const message of page.pending.splice(0)) response.write(`data: ${JSON.stringify(message)}\n\n`);
      response.on('close', () => { if (page.stream === response) page.stream = undefined; });
    } else if (url.pathname === '/current/host' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const envelope = JSON.parse(body);
      const page = sessions.get(envelope.session);
      if (!page) { response.writeHead(404).end(); return true; }
      record({ side: 'current', kind: 'host.request', page: page.number, message: envelope });
      page.mounted.messages.fire(envelope);
      response.writeHead(202).end();
    } else if (url.pathname === '/current/close' && request.method === 'POST') {
      const session = url.searchParams.get('session');
      const page = sessions.get(session);
      page?.mounted.dispose();
      page?.stream?.end();
      sessions.delete(session);
      response.writeHead(204).end();
    } else if (url.pathname === '/current/bridge.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(new URL('./current-bridge.js', import.meta.url)));
    } else if (url.pathname.startsWith('/current/assets/')) {
      const file = resolve(assetRoot, decodeURIComponent(url.pathname.slice('/current/assets/'.length)));
      if (!file.startsWith(`${assetRoot}/`)) { response.writeHead(404).end(); return true; }
      response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.css') ? 'text/css' : file.endsWith('.ttf') ? 'font/ttf' : 'text/javascript');
      response.end(await readFile(file));
    } else response.writeHead(404).end();
    return true;
  }

  return {
    handle,
    metadata: { currentRoot, host: 'packaged extension host', renderer: 'packaged WebAssembly', transport: 'mounted production view through local SSE', editor: 'commands and actual content provider results recorded' },
    async close() {
      for (const page of sessions.values()) { page.mounted.dispose(); page.stream?.end(); }
      sessions.clear();
      await extension.deactivate();
      for (const disposable of f.context.subscriptions) disposable.dispose();
      await writeFile(join(runDirectory, 'host-output.json'), JSON.stringify(f.calls.output, null, 2));
    },
  };
}
