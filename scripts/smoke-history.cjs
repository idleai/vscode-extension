const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Resolve real stored records through the packaged service and native providers. */
async function smokeHistory(host, f, binary, extensionPath) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-native-history-'));
  let lease;
  try {
    execFileSync('cargo', ['run', '--manifest-path', '../host-tools/Cargo.toml', '--quiet', '--locked', '-p', 'idle-history-native', '--example', 'history-fixture', '--', root], { stdio: 'inherit' });
    const fixture = JSON.parse(await fs.readFile(path.join(root, 'history.json'), 'utf8'));
    const resource = f.api.Uri.parse(pathToFileURL(root).toString());
    f.api.workspace.workspaceFolders = [{ name: 'history', uri: resource }];
    assert.equal(path.dirname(binary), path.join(extensionPath, 'bin', `${process.platform}-${process.arch}`));
    lease = host.history.connect({ root: resource, repository: fixture.binding, chainDirectory: path.join(root, 'chain') });
    const page = await host.history.query({ binding: fixture.binding, operation: {
      chain: fixture.binding.chain, action: { History: { filter: { kinds: [], session: null, author: null, recorder: null, path: null }, page: { after: null, limit: 100 } } },
    } });
    assert.ok(page.Ok.History.observations.length >= 4, 'app-core reads use the packaged engine');
    const details = await host.history.query({ binding: fixture.binding, operation: {
      chain: fixture.binding.chain, action: { OperationDetails: { operation: fixture.requests[0].record.operation } },
    } });
    assert.deepEqual(details.Ok.OperationDetails.records[0].bytes, fixture.encoded, 'the assembled inspector receives exact retained record bytes');
    const activity = await host.history.activity({ binding: fixture.binding, source: 'current',
      selection: { Record: fixture.requests[0].record } }, new AbortController().signal);
    assert.equal(activity.text, Buffer.from(fixture.after).toString('utf8'), 'packaged activity reads use the exact file snapshot');
    assert.deepEqual(activity.record, fixture.requests[0].record);
    assert.ok(activity.indicators.some(indicator => indicator.kind === 'unknown'), 'missing authors stay explicit');
    assert.ok(activity.issues.some(issue => issue.includes('No exposure observations')), 'missing exposure is not classified as unread');
    await assert.rejects(host.history.query({ binding: fixture.binding, operation: { chain: 'another-chain', action: 'Invalid' } }), { code: 'binding_mismatch' });
    const documents = f.calls.fileProviders.find(value => value.scheme === 'idle-history').provider;
    const hex = f.calls.contentProviders.find(value => value.scheme === 'idle-history-hex').provider;
    const text = f.calls.contentProviders.find(value => value.scheme === 'idle-history-text').provider;
    const expected = [[fixture.after], [fixture.before, fixture.after], [fixture.encoded], [fixture.raw], [[]]];
    for (let index = 0; index < expected.length; index++) {
      const opened = await host.history.open(fixture.requests[index]);
      for (let part = 0; part < expected[index].length; part++) {
        const bytes = await documents.readFile(f.api.Uri.parse(opened.byteUris[part]));
        assert.deepEqual(Buffer.from(bytes), Buffer.from(expected[index][part]));
        if (opened.uris[part].startsWith('idle-history-hex:')) {
          const content = await hex.provideTextDocumentContent(f.api.Uri.parse(opened.uris[part]));
          const decoded = content.split('\n').flatMap(line => line.split('  ')[1].split(' ').map(byte => parseInt(byte, 16)));
          assert.deepEqual(Buffer.from(decoded), Buffer.from(bytes));
        } else {
          const content = await text.provideTextDocumentContent(f.api.Uri.parse(opened.uris[part]));
          assert.deepEqual(Buffer.from(content, 'utf8'), Buffer.from(bytes));
        }
      }
    }
    const beforeRestart = await host.history.open(fixture.requests[0]);
    await f.commands.get('idle.restartNative')();
    await assert.rejects(documents.readFile(f.api.Uri.parse(beforeRestart.byteUris[0])), { code: 'unavailable' });
    const afterRestart = await host.history.open(fixture.requests[0]);
    assert.deepEqual(Buffer.from(await documents.readFile(f.api.Uri.parse(afterRestart.byteUris[0]))), Buffer.from(fixture.after));
    await assert.rejects(host.history.open(fixture.requests[5]), { code: 'missing_content' });
    await assert.rejects(fs.readFile(path.join(root, 'recorded.ts')), { code: 'ENOENT' });
    console.log('PASS: packaged native previews match engine bytes, retain bindings across Restart Native, and keep missing content distinct from empty content.');
  } finally {
    lease?.dispose();
    await host.history.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}

module.exports = { smokeHistory };
