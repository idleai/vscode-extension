const assert = require('node:assert/strict');
const path = require('node:path');

function smokeNativeSidebar(extensionDirectory) {
  const { NativeSidebar } = require(path.join(extensionDirectory, 'dist/native/idle_vscode_webview.js'));
  assert.equal(typeof globalThis.document, 'undefined', 'native trees must run without a browser');
  const runtime = new NativeSidebar();
  const apply = (type, value) => JSON.parse(runtime.update(JSON.stringify({ type, value })));
  const rows = (state, id) => state.trees.find(tree => tree.id === id).rows;
  try {
    const ready = apply('Ready', {});
    assert.equal(ready.trees.length, 6);
    assert.ok(!ready.trees.some(tree => tree.id === 'idle.activity'), 'Activity remains a custom webview');
    const directory = ['one', 'two'].map(id => ({ id, name: id, chain: `chain-${id}`, revision: 1,
      mode: 'Standalone', repositories: [{ id: `repository-${id}`, name: id, remote: null }] }));
    const state = apply('Reply', { id: ready.calls[0].id, result: { Ok: { Ok: { Directory: directory } } } });
    const selected = apply('Activate', rows(state, 'idle.workspace')[1].id);
    assert.deepEqual(selected.selection, { workspace_id: 'two', repository_id: 'repository-two', chain: 'chain-two' });
    const control = rows(selected, 'idle.sessions')[0];
    const detail = apply('Activate', control.id);
    assert.equal(detail.detail.section, 'Sessions');
    assert.deepEqual(detail.detail.binding, selected.selection);
    apply('Reset');
    assert.throws(() => apply('Activate', control.id));
  } finally { runtime.free(); }
  console.log('PASS: packaged Rust native-tree runtime loads without a browser and routes bound selections.');
}

module.exports = { smokeNativeSidebar };
