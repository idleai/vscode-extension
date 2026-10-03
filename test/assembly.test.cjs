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
  const host = new AssemblyHost(new HostConfiguration('/extension'), history, effects, error => assert.fail(String(error)));
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

for (const broken of ['one', 'two']) test('an invalid ' + broken + ' folder preserves other history bindings and can recover', async () => {
  const effects = new HostEffects(() => true);
  const released = [];
  const failures = [];
  const bindings = [];
  const history = { connect(binding) { bindings.push(binding); return { dispose() { released.push(binding); } }; } };
  const host = new AssemblyHost(new HostConfiguration('/extension'), history, effects,
    (folder, error) => failures.push({ folder, code: error.code }));
  const context = { session: 'view', signal: new AbortController().signal };
  f.configuration.set('file:///' + broken, { chainDirectory: '' });
  try {
    const result = await effects.execute('app.workspace', { operation: 'List' }, context);
    assert.equal(result.Ok.Directory.length, 1);
    const workspace = result.Ok.Directory[0];
    assert.equal(workspace.name, broken === 'one' ? 'two' : 'one');
    assert.deepEqual(failures, [{ folder: broken, code: 'invalid_configuration' }]);
    assert.equal(released.length, 0, 'a different root failing must not disconnect the healthy binding');
    const snapshot = await effects.execute('app.workspace', { operation: { Snapshot: { workspace_id: workspace.id, mode: 'Standalone' } } }, context);
    assert.deepEqual(snapshot.Ok.Snapshot.workspace, workspace);
    assert.deepEqual(await effects.execute('app.workspace', { operation: 'List' }, context), result);
    assert.equal(failures.length, 1, 'repeat views do not repeat the notification');
    f.configuration.delete('file:///' + broken);
    host.reset();
    const recovered = await effects.execute('app.workspace', { operation: 'List' }, context);
    assert.equal(recovered.Ok.Directory.length, 2);
    assert.deepEqual(recovered.Ok.Directory.find(value => value.name === workspace.name), workspace);
    assert.equal(released.length, 1);
  } finally { f.configuration.delete('file:///' + broken); host.dispose(); effects.dispose(); }
  assert.deepEqual(released, bindings, 'every successful binding is released once');
});
