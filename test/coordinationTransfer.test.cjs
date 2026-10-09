const test = require('node:test');
const assert = require('node:assert/strict');
const { transferCoordination } = require('../out/host/coordinationTransfer');

const target = { host_id: 'daemon', checkout_id: 'checkout' };
const receipt = { transfer_id: 'original-transfer', package_hash: 'frozen-package-digest', target };
const ok = value => JSON.stringify({ version: 1, id: '1', result: { Ok: value } });

function model() {
  const bytes = Buffer.from(JSON.stringify({ recordedResult: 'original-request', privateData: 'x'.repeat(90_000) }));
  const state = { frozen: false, accepted: false, completed: false, loseReply: false,
    revision: 'matching-files', calls: [], received: [] };
  const client = { async request(raw) {
    const command = JSON.parse(raw); state.calls.push(command);
    switch (command.kind) {
      case 'runtime_transfer_status': return ok(state.frozen ? receipt : null);
      case 'workspace_configuration': return ok({ revision: 'matching-files' });
      case 'prepare_runtime_transfer':
        assert.deepEqual(command.data.target, target);
        state.frozen = true; return ok(receipt);
      case 'runtime_transfer_chunk': {
        const offset = command.data;
        return ok({ receipt, total: bytes.length, offset, content: bytes.subarray(offset, offset + 64 * 1024).toString('base64') });
      }
      case 'complete_runtime_transfer':
        assert.deepEqual(command.data, receipt); state.completed = true; return ok(null);
      default: throw new Error('Unexpected local command');
    }
  } };
  const send = async raw => {
    const request = JSON.parse(raw);
    if (request.kind === 'status') return ok({ target, receipt: state.accepted ? receipt : null, configuration_revision: state.revision });
    if (request.kind === 'upload') {
      assert.deepEqual(request.receipt, receipt);
      if (request.offset === 0) state.received = [];
      state.received.push(Buffer.from(request.content, 'base64'));
      return ok({ received: request.total });
    }
    assert.equal(request.kind, 'commit');
    assert.deepEqual(request.receipt, receipt);
    assert.deepEqual(Buffer.concat(state.received), bytes);
    state.accepted = true;
    if (state.loseReply) { state.loseReply = false; throw new Error('connection lost'); }
    return ok(receipt);
  };
  return { state, client, send };
}

test('lost transfer response retries the original package without overwriting later daemon work', async () => {
  const { state, client, send } = model();
  state.loseReply = true;
  await assert.rejects(transferCoordination(client, send, () => {}), /connection lost/);
  assert.ok(state.frozen && state.accepted && !state.completed);
  state.revision = 'later-daemon-write';
  await transferCoordination(client, send, () => {});
  assert.ok(state.completed);
  assert.equal(state.calls.filter(command => command.kind === 'workspace_configuration').length, 1,
    'a frozen retry must use its retained bytes even when destination files have changed');
  assert.ok(state.received.length > 1);
});

test('different checkout definitions are refused before the local authority freezes', async () => {
  const { state, client, send } = model();
  state.revision = 'different-files';
  await assert.rejects(transferCoordination(client, send, () => {}), { code: 'coordination_conflict' });
  assert.equal(state.frozen, false);
  assert.equal(state.accepted, false);
});

test('an occupied destination is refused before the local authority freezes', async () => {
  const { state, client, send } = model();
  state.accepted = true;
  await assert.rejects(transferCoordination(client, send, () => {}), { code: 'coordination_conflict' });
  assert.equal(state.frozen, false);
  assert.deepEqual(state.calls.map(command => command.kind), ['runtime_transfer_status']);
});

test('a workspace reset during preflight cannot start a transfer', async () => {
  const { state, client, send } = model();
  await assert.rejects(transferCoordination(client, send, () => { throw new Error('workspace changed'); }), /workspace changed/);
  assert.equal(state.frozen, false);
});
