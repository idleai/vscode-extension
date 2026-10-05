const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, loadWithVSCode } = require('./vscode.cjs');
const { HostError } = require('../../out/host/protocol');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Sharing transition did not finish.');
}

function setup(prepare = () => {}, customize = () => {}) {
  const f = fixture(), managers = [], errors = [], notices = [], log = [], secrets = new Map();
  let selected = 0, accountCalls = 0;
  const configuration = {
    assertTrusted() { if (!f.api.workspace.isTrusted) throw new HostError('workspace_untrusted', 'Trust is required.'); },
    forResource(uri) {
      this.assertTrusted();
      const folder = f.api.workspace.workspaceFolders.find(folder => folder.uri.toString() === uri.toString());
      if (!folder) throw new HostError('workspace_unavailable', 'Folder was removed.');
      return { folder, chainDirectory: path.join(folder.uri.fsPath, f.configuration.get(uri.toString())?.chainDirectory ?? '.editchain') };
    },
  };
  const credentials = {
    async account() { accountCalls++; return f.api.authentication.session?.account; },
    tokenProvider() { return async () => 'test-token'; },
    async get(key) { return secrets.get(key); },
    async store(key, _name, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); },
  };
  const diagnostics = { append: value => log.push(value), show() {},
    failure: (operation, error) => errors.push({ operation, error }),
    async notify(_level, text) { notices.push(text); },
    async command(operation, run) { try { return await run(); } catch (error) { errors.push({ operation, error }); } },
  };
  f.api.window.showQuickPick = async choices => {
    f.calls.choices.push(choices);
    return choices[0]?.folder ? choices[selected] : choices[0];
  };
  f.api.window.showInputBox = async () => 'private fixture input';
  f.api.window.showWarningMessage = async (_text, _options, action) => action;
  const factory = options => {
    const state = { enabled: false, hosting: false, peers: [] };
    const manager = {
      options, stopped: 0, suspended: 0, hosted: [], resumed: [], reconnected: 0, directories: [], importedMarkers: [],
      status: () => ({ ...state }), async joinRequest() { return 'public request'; },
      async inspectRequest() { return { device: { fingerprint: 'a'.repeat(64) } }; },
      async inspectInvitation() { return { space: 'space', host: { fingerprint: 'b'.repeat(64) } }; },
      async sharingScope() { return state.enabled ? { active: true, mode: 'all' } : undefined; },
      async hostHistory(_text, scope) {
        manager.hosted.push(scope); state.enabled = true; state.hosting = true;
        await options.saveEnabled(true);
        options.changed(state, false); return 'private invitation';
      },
      async joinHistory() { state.enabled = true; await options.saveEnabled(true); options.changed(state, false); },
      async importSaved(value) { manager.resumed.push(value); },
      async importCleanup(markers) { manager.importedMarkers.push(...markers); }, async configureDirectory(repository) { manager.directories.push(repository); }, async cleanup() {},
      async resume() { state.enabled = true; options.changed(state, false); },
      async reconnect() { manager.reconnected++; },
      async devices() { return [{ fingerprint: 'a'.repeat(64) }]; },
      async revoke() { await options.saveEnabled(true); },
      async changeScope() {},
      async stop() { manager.stopped++; state.enabled = false; options.changed(state, false); await options.saveEnabled(false); },
      async suspend() { manager.suspended++; state.enabled = false; options.changed(state, false); },
    };
    customize(manager); managers.push(manager); return manager;
  };
  delete require.cache[require.resolve('../../out/sharing')];
  const { SharingHost, sharingKey } = loadWithVSCode('../../out/sharing', f.api);
  const key = index => sharingKey(f.api.workspace.workspaceFolders[index].uri,
    configuration.forResource(f.api.workspace.workspaceFolders[index].uri).chainDirectory);
  prepare({ f, credentials, key, secrets });
  const host = new SharingHost(f.context, configuration, credentials, diagnostics, { connection() { throw new Error("The sharing host fixture supplies its own manager."); } }, factory);
  return { f, host, managers, errors, notices, log, secrets, credentials, key,
    choose: index => { selected = index; }, accounts: () => accountCalls, tunnels: () => 0,
    run: name => f.commands.get('idle.sharing.' + name)() };
}

module.exports = { setup, deferred, until };
