const { fixture } = require('../helpers/vscode.cjs');
const { harness } = require('./native-host-fake.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));

function runnerHarness(t, api, RuntimeHost, RunnerSessions) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const output = [], decisions = [];
  const server = { threads: new Map(), approvals: new Map(), notifications: [], failEvents: 0, failStatus: 0 };
  t.mock.method(api.window, 'createOutputChannel', () => ({
    appendLine: text => output.push(text), append: text => output.push(text),
    clear() { output.length = 0; }, show() {}, dispose() {},
  }));
  t.mock.method(api.window, 'showQuickPick', async choices => choices[0]);
  t.mock.method(api.window, 'showWarningMessage', async () => undefined);
  const native = harness(t, { features: ['runtime.workspace', 'runtime.runners'], request(channel, call) {
    if (call.kind !== 'call') return;
    channel.subscriptions ??= new Set();
    const command = call.data.command;
    const reply = result => channel.reply({ version: 1, id: call.data.id, result });
    if (channel.broken || command.kind === 'runner_events' && server.failEvents > 0
      || command.kind === 'status' && server.failStatus > 0) {
      if (command.kind === 'runner_events' && server.failEvents > 0) server.failEvents--;
      if (command.kind === 'status' && server.failStatus > 0) server.failStatus--;
      channel.broken = true;
      reply({ Err: 'transport' });
      return;
    }
    let result;
    if (command.kind === 'status') result = { status: { capabilities: ['runnerSessions'] } };
    else if (command.kind === 'runner_events') {
      const notifications = server.notifications.filter(value => channel.subscriptions.has(value.params.threadId));
      server.notifications = server.notifications.filter(value => !notifications.includes(value));
      result = { notifications, approvals: [...server.approvals.values()]
        .filter(value => channel.subscriptions.has(value.params.threadId)) };
    } else if (command.kind === 'runner_approve') {
      const approval = server.approvals.get(command.id);
      if (!approval || !channel.subscriptions.has(approval.params.threadId)) { reply({ Err: 'invalid' }); return; }
      decisions.push({ ...command, invitation: channel.installation.service.binding.invitation });
      server.approvals.delete(command.id);
      result = { submitted: true };
    } else {
      const id = command.method === 'thread/start'
        ? `aa000000-0000-0000-0000-${String(server.threads.size + 1).padStart(12, '0')}` : command.params.threadId;
      if (command.method === 'thread/start') {
        server.threads.set(id, { id, turns: [] });
        channel.subscriptions.add(id);
      }
      if (command.method === 'thread/resume') {
        // Native host 0.5.2 closes its stream when resume replays an existing pending approval.
        channel.broken = channel.subscriptions.has(id)
          && [...server.approvals.values()].some(value => value.params.threadId === id);
        channel.subscriptions.add(id);
      }
      result = { response: { result: command.method.startsWith('thread/')
        ? { thread: server.threads.get(id) } : { turn: { id: 'active-turn', status: 'inProgress' } } } };
    }
    reply({ Ok: result });
  } });
  const context = fixture().context;
  const runtime = new RuntimeHost(context, { assertTrusted() {} }, native.host, async () => 'owner', 'runner');
  const sessions = new RunnerSessions(context, runtime);
  t.after(() => sessions.shutdown());
  return { sessions, runtime, native, server, output, decisions, context,
    async advance(ms) { t.mock.timers.tick(ms); await tick(); },
    async settle() { await tick(); },
    pending(threadId, id = 0) {
      const approval = { id, method: 'item/commandExecution/requestApproval', params: {
        threadId, turnId: 'active-turn', itemId: 'command', command: 'echo reviewed', cwd: '/compute/workspace',
      } };
      server.approvals.set(id, approval);
      return approval;
    },
    commands() { return native.channels.flatMap(channel => channel.requests.map(call => call.data.command)); },
  };
}

module.exports = { runnerHarness };
