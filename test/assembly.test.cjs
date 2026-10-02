const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, loadWithVSCode } = require('./helpers/vscode.cjs');
const { HostEffects } = require('../out/host/effects');

const f = fixture();
const { HostConfiguration } = loadWithVSCode('../../out/host/configuration', f.api);
const { AssemblyHost } = loadWithVSCode('../../out/host/assembly', f.api);

test('local discovery installs explicit independent folder bindings without processes or account access', async () => {
  const effects = new HostEffects(() => f.api.workspace.isTrusted);
  const bindings = [];
  const released = [];
  const queries = [];
  const history = { connect(binding) { bindings.push(binding); return { dispose() { released.push(binding); } }; },
    query(params, signal) { queries.push({ params, signal }); return { Ok: 'Opened' }; } };
  const host = new AssemblyHost(new HostConfiguration('/extension'), history, effects);
  const context = { session: 'view', signal: new AbortController().signal };
  try {
    const result = await effects.execute('app.workspace', { operation: 'List' }, context);
    assert.equal(result.Ok.Directory.length, 2);
    assert.notEqual(bindings[0].repository.chain, bindings[1].repository.chain);
    assert.equal(bindings[0].chainDirectory, '/one/.editchain');
    assert.equal(bindings[1].chainDirectory, '/two/.editchain');
    assert.equal(JSON.stringify(result).includes('/one'), false, 'physical paths stay in the host');
    const workspace = result.Ok.Directory[1];
    const snapshot = await effects.execute('app.workspace', { operation: { Snapshot: { workspace_id: workspace.id, mode: 'Standalone' } } }, context);
    assert.deepEqual(snapshot.Ok.Snapshot.workspace, workspace);
    await effects.execute('app.workspace', { operation: 'List' }, context);
    assert.equal(bindings.length, 2, 'opening another view preserves installed services');
    assert.equal(f.calls.auth.length, 0);
    const params = { binding: bindings[1].repository, operation: { chain: workspace.chain } };
    await effects.execute('app.history', params, context);
    assert.deepEqual(queries[0], { params, signal: context.signal });
    await assert.rejects(effects.execute('app.workspace', { operation: { Snapshot: { workspace_id: workspace.id, mode: 'Managed' } } }, context), { code: 'unavailable' });
    host.reset();
    assert.equal(released.length, 2);
    const next = await effects.execute('app.workspace', { operation: 'List' }, context);
    assert.deepEqual(next, result, 'local aliases are stable across view and process lifetimes');
    f.api.workspace.isTrusted = false;
    await assert.rejects(effects.execute('app.history', params, context), { code: 'workspace_untrusted' });
  } finally { f.api.workspace.isTrusted = true; host.dispose(); effects.dispose(); }
});
