const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadWithVSCode } = require('./helpers/vscode.cjs');
const { harness } = require('./fixtures/native-host-fake.cjs');

const f = fixture();
const { RuntimeHost } = loadWithVSCode('../../out/host/runtime', f.api);
const { RunnerSessions } = loadWithVSCode('../../out/host/runners', f.api);
const workspace = { config: { cwd: '/workspace' }, binding: { workspace_id: 'workspace', repository_id: 'repository', chain: 'chain' } };
const id = 'aa000000-0000-0000-0000-000000000001';

test('runner invitations and calls leave the coordination connection usable', async t => {
  const context = fixture().context;
  const native = harness(t, { features: ['runtime.workspace', 'runtime.runners', 'coordination.runtime-owner'], request(channel, call) {
    if (call.kind !== 'call') return;
    const runner = channel.installation.service.binding.invitation.endsWith('RUNNER');
    const command = call.data.command;
    const result = command.kind === 'status'
      ? { status: { capabilities: [runner ? 'runnerSessions' : 'workspaceCoordination'] } }
      : command.kind === 'runner' ? { response: { result: { thread: { id } } } } : { coordinated: true };
    channel.reply({ version: 1, id: call.data.id, result: { Ok: result } });
  } });
  const configuration = { assertTrusted() {} };
  const owner = new RuntimeHost(context, configuration, native.host, async () => 'owner');
  const runner = new RuntimeHost(context, configuration, native.host, async () => 'owner', 'runner');
  t.after(async () => { await runner.shutdown(); await owner.shutdown(); });
  await owner.connect(workspace.config, workspace.binding, 'idle-runtime:OWNER');
  await runner.connect(workspace.config, workspace.binding, 'idle-runtime:RUNNER');
  assert.equal(context.globalState.keys().length, 2);
  const created = await runner.runner(workspace.config, workspace.binding, { kind: 'runner', method: 'thread/start', params: {} });
  assert.equal(created.response.result.thread.id, id);
  assert.equal(JSON.parse(await owner.coordination(workspace.config, workspace.binding, '{"kind":"status"}')).result.Ok.coordinated, true);
  await runner.disconnect(workspace.binding);
  assert.equal((await owner.snapshot(workspace.config, workspace.binding)).connected, true);
  assert.equal(native.channels[0].closed, false);
});

test('runner controls refuse a connection without runner permission', async t => {
  const native = harness(t, { features: ['runtime.workspace', 'runtime.runners'], request(channel, call) {
    channel.reply({ version: 1, id: call.data.id, result: { Ok: { status: { capabilities: ['workspaceCoordination'] } } } });
  } });
  const context = fixture().context;
  const runner = new RuntimeHost(context, { assertTrusted() {} }, native.host, async () => 'owner', 'runner');
  t.after(() => runner.shutdown());
  await assert.rejects(runner.connect(workspace.config, workspace.binding, 'idle-runtime:OWNER'), { code: 'denied' });
  assert.equal(context.globalState.keys().length, 0);
  assert.ok(native.channels[0].closed);
});

test('closing the editor controls does not submit an interrupt or approval', async t => {
  const calls = [];
  const context = fixture().context;
  const connection = { reset: async () => {}, shutdown: async () => {}, runner: async (_config, _binding, command) => {
    calls.push(command);
    return command.kind === 'runner_events' ? { notifications: [], approvals: [] }
      : { response: { result: { thread: { id } } } };
  } };
  const sessions = new RunnerSessions(context, connection);
  t.after(() => sessions.shutdown());
  await sessions.start(workspace, 'Create a report in the permitted checkout');
  await sessions.shutdown();
  assert.deepEqual(calls.filter(call => call.kind === 'runner'), [
    { kind: 'runner', method: 'thread/start', params: {} },
    { kind: 'runner', method: 'turn/start', params: { threadId: id, input: [{ type: 'text', text: 'Create a report in the permitted checkout' }] } },
  ]);
  assert.equal(calls.some(call => call.kind === 'runner_approve'), false);
});

test('a command is approved only after its full text is shown and the user accepts', async t => {
  const decisions = [], documents = [];
  const command = 'echo first\necho second';
  const connection = { reset: async () => {}, shutdown: async () => {}, runner: async (_config, _binding, request) => {
    if (request.kind === 'runner_approve') { decisions.push(request); return { submitted: true }; }
    return { notifications: [], approvals: [{ id: 'pending', params: { command, cwd: '/compute/workspace' } }] };
  } };
  const sessions = new RunnerSessions(fixture().context, connection);
  t.after(() => sessions.shutdown());
  t.mock.method(f.api.window, 'showQuickPick', async choices => choices[0]);
  f.api.workspace.openTextDocument = async value => { documents.push(value); return value; };
  f.api.window.showTextDocument = async () => {};
  let answer;
  t.mock.method(f.api.window, 'showWarningMessage', async () => answer);
  await sessions.review(workspace);
  assert.equal(decisions.length, 0, 'closing the prompt keeps approval pending');
  answer = 'Run Command';
  await sessions.review(workspace);
  assert.ok(documents.every(document => document.content.includes(command)));
  assert.deepEqual(decisions, [{ kind: 'runner_approve', id: 'pending', decision: 'accept' }]);
});
