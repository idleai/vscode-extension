const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConfigurationJournal } = require('../out/host/configurationJournal');

const binding = { workspace_id: 'workspace', repository_id: 'repository', chain: 'chain' };
const contributor = 'local-contributor:test';
function draft(document = 'Settings') {
  return JSON.stringify([{ context: { provider: 'idle-local', mode: 'Standalone', workspace_id: 'workspace', chain: 'chain', contributor_id: contributor },
    document, value: { schema_version: 1, json: '{invalid intermediate text' },
    base: { revision: 'LARGE_REVISION', value: { schema_version: 1, json: '{"unknown":true}' } }, pending: null }])
    .replace('"LARGE_REVISION"', '9007199254740993');
}
async function journal(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-configuration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, state: new ConfigurationJournal(directory) };
}

test('drafts survive reopening with exact revisions and independent document/view scopes', async t => {
  const { directory, state } = await journal(t);
  await Promise.all([
    state.writeDrafts(binding, contributor, 'sidebar', draft()),
    state.writeDrafts(binding, contributor, 'detail', draft('AgentRules')),
  ]);
  const reopened = new ConfigurationJournal(directory);
  assert.equal(await reopened.readDrafts(binding, contributor, 'sidebar'), draft());
  assert.equal(await reopened.readDrafts(binding, contributor, 'detail'), draft('AgentRules'));
  assert.equal(await reopened.readDrafts(binding, 'another-contributor', 'sidebar'), '[]');
  assert.equal(await reopened.readDrafts({ ...binding, chain: 'another-chain' }, contributor, 'sidebar'), '[]');
  for (const name of await fs.readdir(directory)) {
    assert.match(name, /^[a-f0-9]{64}\.json$/);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
  }
});

test('ordered stores retain the latest accepted edit and reject invalid scope without replacing it', async t => {
  const { state } = await journal(t);
  await Promise.all([state.writeDrafts(binding, contributor, 'sidebar', draft()), state.writeDrafts(binding, contributor, 'sidebar', '[]')]);
  assert.equal(await state.readDrafts(binding, contributor, 'sidebar'), '[]');
  assert.throws(() => state.writeDrafts(binding, contributor, 'sidebar', draft().replace('workspace_id":"workspace', 'workspace_id":"other')), { code: 'invalid_request' });
  assert.throws(() => state.writeDrafts(binding, contributor, 'sidebar', '['), { code: 'invalid_request' });
  assert.equal(await state.readDrafts(binding, contributor, 'sidebar'), '[]');
});

test('uncertain writes retain the exact original command across restart', async t => {
  const { directory, state } = await journal(t);
  const original = '{"revision":"9007199254740993","expires_at":"10000","value":"first"}';
  await state.prepare(binding, contributor, 'save:1', original);
  const reopened = new ConfigurationJournal(directory);
  await reopened.prepare(binding, contributor, 'save:1', original);
  await assert.rejects(reopened.prepare(binding, contributor, 'save:1', original.replace('first', 'second')), { code: 'invalid_request' });
  assert.equal(await fs.readFile(path.join(directory, (await fs.readdir(directory))[0]), 'utf8'), original);
  await reopened.settled(binding, contributor, 'save:1');
  assert.deepEqual(await fs.readdir(directory), []);
});

test('corrupt stored state is retained and reported instead of silently overwritten', async t => {
  const { directory, state } = await journal(t);
  await state.writeDrafts(binding, contributor, 'sidebar', draft());
  const file = path.join(directory, (await fs.readdir(directory))[0]);
  await fs.writeFile(file, '{corrupt');
  await assert.rejects(state.readDrafts(binding, contributor, 'sidebar'), { code: 'invalid_request' });
  assert.equal(await fs.readFile(file, 'utf8'), '{corrupt');
});
