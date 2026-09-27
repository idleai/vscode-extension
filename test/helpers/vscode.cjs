const Module = require('node:module');

class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) callback(value); }
  dispose() { this.listeners.clear(); }
}

function uri(value) {
  const parsed = new URL(value);
  return { scheme: parsed.protocol.slice(0, -1), authority: parsed.host, fsPath: decodeURIComponent(parsed.pathname), toString: () => value };
}

function fixture() {
  const commands = new Map();
  const events = Object.fromEntries(['configuration', 'folders', 'trust', 'authentication'].map(key => [key, new Emitter()]));
  const calls = { auth: [], output: [], notifications: [], external: [], clipboard: [], providers: [], panels: [] };
  const secrets = new Map();
  const state = new Map();
  const configuration = new Map();
  const api = {
    EventEmitter: Emitter,
    Uri: { parse: uri, joinPath: (base, ...parts) => uri(`${base.toString()}/${parts.join('/')}`) },
    StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: 1 },
    workspace: {
      isTrusted: true,
      workspaceFolders: ['/one', '/two'].map((path, index) => ({ name: path.slice(1), index, uri: uri(`file://${path}`) })),
      getWorkspaceFolder: target => api.workspace.workspaceFolders.find(folder => target.toString() === folder.uri.toString() || target.toString().startsWith(folder.uri.toString() + '/')),
      getConfiguration: (_, resource) => ({ get: (key, fallback) => configuration.get(resource?.toString())?.[key] ?? fallback }),
      onDidChangeConfiguration: events.configuration.event,
      onDidChangeWorkspaceFolders: events.folders.event,
      onDidGrantWorkspaceTrust: events.trust.event,
    },
    env: { remoteName: undefined, clipboard: { writeText: async text => { calls.clipboard.push(text); } }, openExternal: async url => { calls.external.push(url.toString()); return true; } },
    authentication: {
      session: { account: { id: 'account', label: 'Tester' }, accessToken: 'TOKEN-NEVER-PRINT', scopes: ['read:user', 'read:org'], id: 'session' },
      getSession: async (...args) => { calls.auth.push(args); return api.authentication.session; },
      onDidChangeSessions: events.authentication.event,
    },
    window: {
      createOutputChannel: () => ({ appendLine: line => calls.output.push(line), show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showInformationMessage: async message => { calls.notifications.push(message); },
      showWarningMessage: async message => { calls.notifications.push(message); },
      showErrorMessage: async message => { calls.notifications.push(message); },
      registerWebviewViewProvider: (id, provider) => { calls.providers.push({ id, provider }); return { dispose() {} }; },
      createWebviewPanel: () => { const panel = view(); panel.reveal = () => {}; calls.panels.push(panel); return panel; },
    },
    commands: {
      registerCommand: (id, run) => { commands.set(id, run); return { dispose: () => commands.delete(id) }; },
      executeCommand: async id => id,
    },
  };
  const context = {
    extensionUri: uri('file:///extension'), subscriptions: [],
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } },
    globalState: { keys: () => [...state.keys()], get: key => state.get(key), update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value); } },
  };
  return { api, context, calls, commands, events, configuration, secrets };
}

function view() {
  const messages = new Emitter();
  const closed = new Emitter();
  return {
    posted: [], messages,
    webview: { cspSource: 'https://assets.example', asWebviewUri: value => value, onDidReceiveMessage: messages.event,
      postMessage: async function(message) { this.owner.posted.push(message); return true; } },
    onDidDispose: closed.event,
    dispose() { closed.fire(); },
    attach() { this.webview.owner = this; return this; },
  }.attach();
}

function loadWithVSCode(file, api) {
  const original = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? api : original.call(this, name, ...args); };
  try { return require(file); } finally { Module._load = original; }
}

module.exports = { fixture, view, uri, loadWithVSCode };
