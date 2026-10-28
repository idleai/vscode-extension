const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadWithVSCode } = require('./helpers/vscode.cjs');
const { harness } = require('./fixtures/native-host-fake.cjs');
const { runnerHarness } = require('./fixtures/runner-host-fake.cjs');

const f = fixture();
f.api.workspace.openTextDocument = async value => value;
f.api.window.showTextDocument = async () => {};
f.api.window.createOutputChannel = () => ({ appendLine() {}, append() {}, clear() {}, show() {}, dispose() {} });
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
  const current = { scope: 'runner' };
  const connection = { runnerConnection: async () => current, reset: async () => {}, shutdown: async () => {}, runner: async (_config, _binding, command) => {
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
  const current = { scope: 'runner' };
  const connection = { runnerConnection: async () => current, reset: async () => {}, shutdown: async () => {}, runner: async (_config, _binding, request) => {
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

async function controls(t) {
  const result = runnerHarness(t, f.api, RuntimeHost, RunnerSessions);
  await result.sessions.connect(workspace, 'idle-runtime:RUNNER');
  return result;
}

test('opening a subscribed runner reads history without replaying its pending approval', async t => {
  const h = await controls(t);
  const threadId = await h.sessions.start(workspace, 'First task');
  h.pending(threadId);
  await h.settle();
  await h.sessions.show(workspace);
  await h.sessions.show(workspace);
  t.mock.method(f.api.window, 'showWarningMessage', async () => 'Run Command');
  await h.sessions.review(workspace);
  assert.equal(h.commands().filter(command => command.method === 'thread/resume').length, 0);
  assert.equal(h.commands().filter(command => command.method === 'thread/read').length, 2);
  assert.equal(h.native.channels[0].broken, undefined, 'the native stream remains usable');
  assert.equal(h.decisions.length, 1);
});

test('sending to a subscribed runner preserves its pending approval stream', async t => {
  const h = await controls(t);
  const threadId = await h.sessions.start(workspace, 'First task');
  h.pending(threadId);
  await h.settle();
  t.mock.method(f.api.window, 'showInputBox', async () => 'Next task');
  await h.sessions.send(workspace);
  assert.equal(h.commands().filter(command => command.method === 'thread/resume').length, 0);
  assert.equal(h.commands().filter(command => command.method === 'turn/start').length, 2);
  assert.equal(h.native.channels[0].broken, undefined);
});

test('an approval notification still opens review after starting another runner', async t => {
  const h = await controls(t);
  let click;
  t.mock.method(f.api.window, 'showInformationMessage', (_message, action) => {
    assert.equal(action, 'Review');
    return new Promise(resolve => { click = resolve; });
  });
  const first = await h.sessions.start(workspace, 'First task');
  h.pending(first);
  await h.settle();
  await h.advance(1000);
  assert.equal(typeof click, 'function');
  await h.sessions.start(workspace, 'Second task');
  t.mock.method(f.api.window, 'showWarningMessage', async () => 'Run Command');
  click('Review');
  await h.settle();
  assert.deepEqual(h.decisions, [{ kind: 'runner_approve', id: 0, decision: 'accept', invitation: 'idle-runtime:RUNNER' }]);
});

test('live output and completion belong only to the selected runner', async t => {
  const h = await controls(t);
  const first = await h.sessions.start(workspace, 'First task');
  const second = await h.sessions.start(workspace, 'Second task');
  await h.sessions.show(workspace);
  await h.settle();
  h.server.notifications.push(
    { method: 'item/agentMessage/delta', params: { threadId: first, delta: 'FIRST OUTPUT' } },
    { method: 'item/commandExecution/outputDelta', params: { threadId: second, delta: 'SECOND OUTPUT' } },
    { method: 'turn/completed', params: { threadId: first, turn: { status: 'failed' } } },
    { method: 'turn/completed', params: { threadId: second, turn: { status: 'completed' } } },
  );
  await h.advance(1000);
  assert.deepEqual(h.output, [`Second task (${second})`, 'SECOND OUTPUT', '\nRunner turn completed.']);
});

test('a transient event failure automatically restores subscriptions, history and approvals', async t => {
  const h = await controls(t);
  const threadId = await h.sessions.start(workspace, 'First task');
  await h.settle();
  h.server.failEvents = 1;
  await h.advance(1000);
  assert.equal(h.native.channels[0].closed, true);
  assert.ok(h.output.some(line => line.includes('Retrying the connection automatically')));
  h.server.threads.get(threadId).turns = [{ status: 'inProgress', items: [{ text: 'Saved while disconnected' }] }];
  h.pending(threadId);
  let announcements = 0;
  t.mock.method(f.api.window, 'showInformationMessage', async () => { announcements++; });
  await h.advance(2000);
  assert.equal(h.native.channels.length, 2);
  assert.deepEqual(h.commands().filter(command => command.method === 'thread/resume'), [
    { kind: 'runner', method: 'thread/resume', params: { threadId, excludeTurns: true } },
  ]);
  assert.ok(h.output.includes('Saved while disconnected'));
  assert.equal(announcements, 1);
  h.server.notifications.push({ method: 'item/agentMessage/delta', params: { threadId, delta: 'Live again' } });
  await h.advance(1000);
  assert.ok(h.output.includes('Live again'));
});

test('explicit reconnect restores the watched runner without waiting for the retry timer', async t => {
  const h = await controls(t);
  const threadId = await h.sessions.start(workspace, 'First task');
  await h.settle();
  h.server.failEvents = 1;
  await h.advance(1000);
  h.pending(threadId);
  await h.sessions.connect(workspace, 'idle-runtime:RUNNER');
  await h.settle();
  assert.equal(h.commands().filter(command => command.method === 'thread/resume').length, 1);
  t.mock.method(f.api.window, 'showWarningMessage', async () => 'Decline');
  await h.sessions.review(workspace);
  assert.equal(h.decisions[0].decision, 'decline');
});

test('an approval opened on an old connection cannot submit after replacement', async t => {
  const h = await controls(t);
  const threadId = await h.sessions.start(workspace, 'First task');
  h.pending(threadId);
  let answer;
  t.mock.method(f.api.window, 'showWarningMessage', () => new Promise(resolve => { answer = resolve; }));
  const review = h.sessions.review(workspace);
  const rejected = assert.rejects(review, { code: 'cancelled' });
  await h.settle();
  assert.equal(typeof answer, 'function');
  await h.sessions.connect(workspace, 'idle-runtime:REPLACEMENT');
  answer('Run Command');
  await rejected;
  assert.deepEqual(h.decisions, []);
  assert.equal(h.commands().some(command => command.kind === 'runner_approve'), false);
  assert.equal(h.commands().some(command => command.method === 'thread/resume'), false,
    'threads from a different invitation are not automatically resumed');
});

test('concurrent opens share one resume on a fresh connection', async t => {
  const h = await controls(t);
  const threadId = await h.sessions.start(workspace, 'First task');
  h.pending(threadId);
  await h.settle();
  await h.runtime.reset();
  await Promise.all([h.sessions.show(workspace), h.sessions.show(workspace)]);
  await h.settle();
  assert.equal(h.commands().filter(command => command.method === 'thread/resume').length, 1);
  t.mock.method(f.api.window, 'showWarningMessage', async () => 'Run Command');
  await h.sessions.review(workspace);
  assert.equal(h.decisions.length, 1);
});

test('a failed status refresh retires the runner connection before reattaching', async t => {
  const h = await controls(t);
  const threadId = await h.sessions.start(workspace, 'First task');
  await h.settle();
  h.pending(threadId);
  h.server.failStatus = 1;
  t.mock.timers.setTime(Date.now() + 11_000);
  assert.equal((await h.runtime.snapshot(workspace.config, workspace.binding)).connected, false);
  assert.equal(h.native.channels[0].closed, true);
  await h.advance(1000);
  assert.equal(h.commands().filter(command => command.method === 'thread/resume').length, 1);
});

test('shutdown cancels a scheduled recovery and does not restart the connection', async t => {
  const h = await controls(t);
  await h.sessions.start(workspace, 'First task');
  await h.settle();
  h.server.failEvents = 1;
  await h.advance(1000);
  await h.sessions.shutdown();
  await h.advance(30_000);
  assert.equal(h.native.channels.length, 1);
  assert.deepEqual(h.decisions, []);
});

test('opening a runner after the daemon closes it attaches again', async t => {
  const h = await controls(t);
  const threadId = await h.sessions.start(workspace, 'First task');
  await h.settle();
  h.server.notifications.push({ method: 'thread/closed', params: { threadId } });
  await h.advance(1000);
  h.native.channels[0].subscriptions.delete(threadId);
  await h.sessions.show(workspace);
  assert.equal(h.commands().filter(command => command.method === 'thread/resume').length, 1);
});

test('watching another workspace retains approvals on the first workspace', async t => {
  const h = await controls(t);
  const first = await h.sessions.start(workspace, 'First workspace');
  await h.settle();
  const other = { config: { cwd: '/other' }, binding: { ...workspace.binding, workspace_id: 'other' } };
  await h.sessions.connect(other, 'idle-runtime:OTHER');
  await h.sessions.start(other, 'Other workspace');
  h.pending(first);
  let click;
  t.mock.method(f.api.window, 'showInformationMessage', () => new Promise(resolve => { click = resolve; }));
  await h.advance(1000);
  assert.equal(typeof click, 'function');
  t.mock.method(f.api.window, 'showWarningMessage', async () => 'Decline');
  click('Review');
  await h.settle();
  assert.equal(h.decisions[0].invitation, 'idle-runtime:RUNNER');
  assert.equal(h.decisions[0].decision, 'decline');
});
