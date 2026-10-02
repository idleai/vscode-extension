'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('live capture resolves the moved exporter and preserves configured and older helper locations', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editchain-live-host-'));
  const workspace = path.join(root, 'editchain');
  const sessions = path.join(root, 'sessions');
  const name = process.platform === 'win32' ? 'codex-session-exporter.exe' : 'codex-session-exporter';
  const canonical = path.join(root, 'codex/tools/codex-session-exporter/target/release', name);
  const legacy = path.join(workspace, 'tools/codex-session-exporter/target/release', name);
  const source = path.join(sessions, 'rollout-fixture.jsonl');
  const settings = { 'live.sessionsPath': sessions };
  const entry = require.resolve('../../out/liveHost');
  const load = Module._load;
  let createLiveSync;
  try {
    for (const helper of [canonical, legacy]) {
      fs.mkdirSync(path.dirname(helper), { recursive: true });
      fs.writeFileSync(helper, '');
    }
    fs.mkdirSync(sessions);
    fs.writeFileSync(source, JSON.stringify({ type: 'session_meta', payload: { id: 'fixture', cwd: workspace } }) + '\n');
    Module._load = function (request, ...args) {
      if (request === 'vscode') return { workspace: {
        workspaceFolders: [{ uri: { fsPath: workspace } }],
        getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
      } };
      return load.call(this, request, ...args);
    };
    ({ createLiveSync } = require(entry));
  } finally {
    Module._load = load;
  }
  try {
    for (const expected of [path.join(root, 'configured-helper'), canonical, legacy, name]) {
      settings['live.codexHelperPath'] = expected.endsWith('configured-helper') ? expected : '';
      if (expected === legacy) fs.unlinkSync(canonical);
      if (expected === name) fs.unlinkSync(legacy);
      let received;
      const request = new Promise(resolve => { received = resolve; });
      const sync = createLiveSync(path.join(root, 'service'), async provider => {
        if (provider) received(provider);
        return false;
      }, () => {}, () => {});
      try {
        sync.wake();
        assert.deepEqual(await request, { sessions_root: sessions, helper: expected, paths: [source] });
      } finally {
        sync.dispose();
      }
    }
  } finally {
    delete require.cache[entry];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
