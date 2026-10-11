'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadWithVSCode } = require('../test/helpers/vscode.cjs');

/** Actual native coordinator and extension routing; cloud/daemon lifecycle is supplied by the caller. */
class CoordinationProbe {
  constructor(f, native, runtime, binding, directory) {
    const { CoordinationHost } = loadWithVSCode('../../out/host/coordination', f.api);
    f.context.globalStorageUri = f.api.Uri.parse(pathToFileURL(path.join(directory, 'editor-private')).toString());
    this.runtime = runtime;
    this.binding = binding;
    this.host = new CoordinationHost(f.context, { assertTrusted() {} }, native, runtime);
    const cwd = path.join(directory, 'editor-checkout');
    this.config = { cwd, chainDirectory: path.join(directory, 'editor-chain'),
      folder: { name: 'Coordination test', uri: f.api.Uri.parse(pathToFileURL(cwd).toString()) } };
  }

  contributor() { return this.host.contributor(); }

  async read(command) {
    const response = await this.host.read(this.config, this.binding, { command: JSON.stringify(command), drafts: '[]' },
      { signal: new AbortController().signal, session: 'live-owner' });
    return JSON.parse(response.native).result.Ok;
  }

  async mutation(id, json, expected) {
    const contributor = await this.contributor();
    return { kind: 'mutate', data: { api_version: '1', control_fence: null,
      context: { workspace_id: this.binding.workspace_id, request_id: id, expires_at: String(Date.now() + 3600_000),
        contributor: { contributor_id: contributor, authenticated_as: { issuer: 'idle-vscode-local', subject: contributor.slice('local-contributor:'.length) } } },
      body: { kind: 'configuration', data: { document: 'Settings', change: { expected, value: { schema_version: 1, json } } } } } };
  }

  async prepare(checkout) {
    await Promise.all([this.config.cwd, this.config.chainDirectory].map(value => fs.mkdir(value, { recursive: true })));
    await this.read({ kind: 'snapshot' });
    this.original = await this.mutation('before-transfer', '{"savedBeforeTransfer":true}', { kind: 'absent' });
    this.originalResult = await this.read(this.original);
    assert.equal(this.originalResult.result.status, 'success');
    this.before = await this.read({ kind: 'snapshot' });
    await fs.cp(path.join(this.config.cwd, '.idle'), path.join(checkout, '.idle'), { recursive: true });
    this.checkout = checkout;
  }

  async transfer() {
    const send = this.runtime.coordination.bind(this.runtime);
    let lost = false;
    this.runtime.coordination = async (...args) => {
      const response = await send(...args);
      if (!lost && JSON.parse(args[2]).kind === 'commit') {
        lost = true;
        await this.runtime.reset();
        throw new Error('Simulated lost transfer acknowledgement');
      }
      return response;
    };
    try { await assert.rejects(this.host.moveToRuntime(this.config, this.binding), /Simulated lost transfer acknowledgement/); }
    finally { this.runtime.coordination = send; }
    this.host.reset();
    await this.host.moveToRuntime(this.config, this.binding);
    assert.deepEqual(await this.read({ kind: 'snapshot' }), this.before, 'transfer preserves the exact workspace snapshot');
    const change = await this.mutation('after-transfer', '{"savedOnDaemon":true}', { kind: 'revision', value: this.before.settings.revision });
    assert.equal((await this.read(change)).result.status, 'success');
    assert.deepEqual(await this.read(this.original), this.originalResult, 'retry returns the original result after transfer');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(this.checkout, '.idle/workspace/settings.json'), 'utf8')), { savedOnDaemon: true });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(this.config.cwd, '.idle/workspace/settings.json'), 'utf8')), { savedBeforeTransfer: true });
    this.after = await this.read({ kind: 'snapshot' });
    console.log('PASS: coordination transfer, lost-acknowledgement recovery, original write retries and daemon-owned configuration');
  }

  reset() { this.host.reset(); }
  async verify() { assert.deepEqual(await this.read({ kind: 'snapshot' }), this.after); }
  async verifyDenied() { await assert.rejects(this.read({ kind: 'snapshot' })); }
  shutdown() { return this.host.shutdown(); }
}

module.exports = { CoordinationProbe };
