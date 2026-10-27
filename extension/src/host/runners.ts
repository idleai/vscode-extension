import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { bindingKey, RepositoryBinding } from '../history/contracts';
import { FolderConfiguration } from './configuration';
import { HostError, record } from './protocol';
import { RunnerCommand, RunnerConnection, RuntimeHost } from './runtime';

export interface RunnerWorkspace { config: FolderConfiguration; binding: RepositoryBinding }
interface SavedRunner { id: string; label: string }
interface RunnerState {
  workspace: RunnerWorkspace;
  connection?: RunnerConnection;
  threads: Map<string, SavedRunner>;
  attached: Set<string>;
  attaching: Map<string, Promise<void>>;
  announced: Set<string>;
  timer?: NodeJS.Timeout;
  polling?: Promise<void>;
  failures: number;
  refreshHistory: boolean;
}

/** Editor controls for native threads. Closing these controls leaves admitted work on the daemon. */
export class RunnerSessions {
  private readonly output = vscode.window.createOutputChannel('Idle Runners');
  private readonly states = new Map<string, RunnerState>();
  private generation = 0;
  private focus?: { state: RunnerState; runner: SavedRunner };

  constructor(private readonly context: vscode.ExtensionContext, readonly connection: RuntimeHost) {}

  async connect(workspace: RunnerWorkspace, invitation: string): Promise<void> {
    const state = this.state(workspace);
    await this.connection.connect(workspace.config, workspace.binding, invitation);
    await this.useConnection(state);
    state.failures = 0;
    clearTimeout(state.timer);
    state.timer = undefined;
    this.watch(state);
  }

  async start(workspace: RunnerWorkspace, prompt: string): Promise<string> {
    this.validatePrompt(prompt);
    const state = this.state(workspace), connection = await this.useConnection(state);
    const started = await this.rpc(state, connection, 'thread/start', {});
    this.assertCurrent(state, connection);
    if (!record(started) || !record(started.thread) || typeof started.thread.id !== 'string') {
      throw new HostError('invalid_data', 'The compute host did not return a runner.');
    }
    const runner = { id: started.thread.id, label: prompt.slice(0, 100) };
    state.threads.set(runner.id, runner);
    state.attached.add(runner.id);
    await this.remember(workspace, runner);
    this.assertCurrent(state, connection);
    this.focus = { state, runner };
    this.output.clear();
    this.output.appendLine(`Runner started: ${runner.id}`);
    this.output.show(true);
    this.watch(state);
    await this.rpc(state, connection, 'turn/start', { threadId: runner.id, input: [{ type: 'text', text: prompt }] });
    return runner.id;
  }

  async show(workspace: RunnerWorkspace): Promise<void> {
    const state = this.state(workspace), connection = await this.useConnection(state);
    const runner = await this.select(workspace);
    if (!runner) return;
    await this.attach(state, connection, runner);
    const thread = await this.read(state, connection, runner);
    await this.remember(workspace, runner);
    this.assertCurrent(state, connection);
    this.focus = { state, runner };
    this.showHistory(runner, thread);
    this.output.show(true);
    this.watch(state);
  }

  async send(workspace: RunnerWorkspace): Promise<void> {
    const state = this.state(workspace), connection = await this.useConnection(state);
    const runner = await this.select(workspace);
    if (!runner) return;
    const prompt = await vscode.window.showInputBox({ title: 'Send to Runner', prompt: 'Describe the next task', ignoreFocusOut: true });
    if (!prompt?.trim()) return;
    this.validatePrompt(prompt);
    await this.attach(state, connection, runner);
    const thread = await this.read(state, connection, runner);
    this.assertCurrent(state, connection);
    this.focus = { state, runner };
    this.showHistory(runner, thread);
    this.watch(state);
    await this.rpc(state, connection, 'turn/start', { threadId: runner.id, input: [{ type: 'text', text: prompt }] });
    this.output.show(true);
  }

  async interrupt(workspace: RunnerWorkspace): Promise<void> {
    const state = this.state(workspace), connection = await this.useConnection(state);
    const runner = await this.select(workspace);
    if (!runner) return;
    const thread = await this.read(state, connection, runner);
    const turns = thread.turns;
    const turn = Array.isArray(turns) ? turns.slice().reverse().find(value => record(value) && value.status === 'inProgress') : undefined;
    if (!record(turn) || typeof turn.id !== 'string') throw new HostError('invalid_request', 'This runner has no active turn.');
    await this.rpc(state, connection, 'turn/interrupt', { threadId: runner.id, turnId: turn.id });
    this.output.appendLine(`Runner ${runner.id}: interrupt requested.`);
  }

  async review(workspace: RunnerWorkspace): Promise<void> {
    const state = this.state(workspace), connection = await this.useConnection(state);
    await this.reviewConnection(state, connection);
  }

  private async reviewConnection(state: RunnerState, connection: RunnerConnection): Promise<void> {
    const events = await this.request(state, connection, { kind: 'runner_events' });
    this.display(state, events);
    const approvals = record(events) && Array.isArray(events.approvals) ? events.approvals : [];
    const choices = approvals.filter(value => record(value) && record(value.params)).map(value => ({
      label: String(value.params.command ?? 'Runner command').slice(0, 160), request: value,
    }));
    if (!choices.length) { await vscode.window.showInformationMessage('No runner commands are waiting for approval.'); return; }
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose the command to review' });
    if (!selected) return;
    this.assertCurrent(state, connection);
    const { id, params } = selected.request;
    if ((typeof id !== 'string' && typeof id !== 'number') || !record(params)) throw new HostError('invalid_data', 'Invalid runner approval.');
    const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content:
      `# Working directory: ${String(params.cwd ?? '')}\n# Reason: ${String(params.reason ?? 'Command requires approval')}\n\n${String(params.command ?? '')}\n` });
    await vscode.window.showTextDocument(document, { preview: true });
    const decision = await vscode.window.showWarningMessage('Run the displayed command within this runner’s existing permissions?',
      { modal: true }, 'Run Command', 'Decline');
    if (!decision) return;
    await this.request(state, connection,
      { kind: 'runner_approve', id, decision: decision === 'Run Command' ? 'accept' : 'decline' });
    this.output.appendLine('Command decision submitted.');
  }

  validatePrompt(prompt: string): void {
    if (Buffer.byteLength(prompt) > 32 * 1024) throw new HostError('invalid_request', 'Runner messages must be at most 32 KiB.');
  }

  private state(workspace: RunnerWorkspace): RunnerState {
    const key = bindingKey(workspace.binding);
    let state = this.states.get(key);
    if (!state) {
      state = { workspace, threads: new Map(), attached: new Set(), attaching: new Map(), announced: new Set(),
        failures: 0, refreshHistory: false };
      this.states.set(key, state);
    }
    return state;
  }

  private assertCurrent(state: RunnerState, connection?: RunnerConnection): void {
    if (this.states.get(bindingKey(state.workspace.binding)) !== state || connection && state.connection !== connection) {
      throw new HostError('cancelled', 'Runner connection changed.');
    }
  }

  private async useConnection(state: RunnerState): Promise<RunnerConnection> {
    this.assertCurrent(state);
    const { config, binding } = state.workspace;
    const connection = await this.connection.runnerConnection(config, binding);
    this.assertCurrent(state);
    if (state.connection !== connection) {
      if (state.connection && state.connection.scope !== connection.scope) {
        state.threads.clear();
        if (this.focus?.state === state) this.focus = undefined;
      }
      state.refreshHistory = state.threads.size > 0;
      state.connection = connection;
      state.attached.clear();
      state.attaching.clear();
      state.announced.clear();
    }
    return connection;
  }

  private async request(state: RunnerState, connection: RunnerConnection, command: RunnerCommand): Promise<unknown> {
    this.assertCurrent(state, connection);
    const { config, binding } = state.workspace;
    const value = await this.connection.runner(config, binding, command, undefined, connection);
    this.assertCurrent(state, connection);
    return value;
  }

  private async rpc(state: RunnerState, connection: RunnerConnection, method: string, params: unknown): Promise<unknown> {
    const value = await this.request(state, connection, { kind: 'runner', method, params });
    if (!record(value) || !record(value.response)) throw new HostError('invalid_data', 'Invalid runner response.');
    if (record(value.response.error)) {
      const message = value.response.error.message;
      throw new HostError('runner_request_failed', typeof message === 'string' ? message.slice(0, 2000) : 'The compute host rejected this runner request.');
    }
    return value.response.result;
  }

  private async attach(state: RunnerState, connection: RunnerConnection, runner: SavedRunner): Promise<void> {
    this.assertCurrent(state, connection);
    if (!state.attached.has(runner.id)) {
      let pending = state.attaching.get(runner.id);
      if (!pending) {
        pending = this.rpc(state, connection, 'thread/resume', { threadId: runner.id, excludeTurns: true }).then(() => {
          this.assertCurrent(state, connection);
          state.attached.add(runner.id);
        }).finally(() => { if (state.attaching.get(runner.id) === pending) state.attaching.delete(runner.id); });
        state.attaching.set(runner.id, pending);
      }
      await pending;
    }
    this.assertCurrent(state, connection);
    state.threads.set(runner.id, runner);
  }

  private async read(state: RunnerState, connection: RunnerConnection, runner: SavedRunner): Promise<Record<string, unknown>> {
    const response = await this.rpc(state, connection, 'thread/read', { threadId: runner.id, includeTurns: true });
    if (!record(response) || !record(response.thread)) throw new HostError('invalid_data', 'Runner history is unavailable.');
    return response.thread;
  }

  private async select(workspace: RunnerWorkspace): Promise<SavedRunner | undefined> {
    const generation = this.generation;
    const runners = this.context.globalState.get<SavedRunner[]>(this.key(workspace)) ?? [];
    const selected = await vscode.window.showQuickPick([
      ...runners.map(runner => ({ label: runner.label, description: runner.id, runner })),
      { label: 'Open an existing runner by ID', description: '', runner: undefined },
    ], { placeHolder: 'Choose a runner on this compute host' });
    if (!selected || generation !== this.generation) return undefined;
    if (selected.runner) return selected.runner;
    const id = await vscode.window.showInputBox({ title: 'Runner ID', prompt: 'Enter the saved runner thread ID' });
    if (!id || generation !== this.generation) return undefined;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HostError('invalid_request', 'Enter a valid runner thread ID.');
    return { id, label: `Runner ${id}` };
  }

  private key(workspace: RunnerWorkspace): string {
    return `runtime.runner.threads.${createHash('sha256').update(bindingKey(workspace.binding)).digest('hex')}`;
  }

  private async remember(workspace: RunnerWorkspace, runner: SavedRunner): Promise<void> {
    const runners = this.context.globalState.get<SavedRunner[]>(this.key(workspace)) ?? [];
    await this.context.globalState.update(this.key(workspace), [runner, ...runners.filter(value => value.id !== runner.id)].slice(0, 64));
  }

  private showHistory(runner: SavedRunner, thread: Record<string, unknown>): void {
    this.output.clear();
    this.output.appendLine(`${runner.label} (${runner.id})`);
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      if (!record(turn)) continue;
      for (const item of Array.isArray(turn.items) ? turn.items : []) {
        if (!record(item)) continue;
        if (typeof item.text === 'string') this.output.appendLine(item.text);
        if (typeof item.aggregatedOutput === 'string') this.output.appendLine(item.aggregatedOutput);
      }
      if (typeof turn.status === 'string') this.output.appendLine(`Turn ${turn.status}.`);
    }
  }

  private display(state: RunnerState, events: unknown): void {
    if (!record(events)) throw new HostError('invalid_data', 'Invalid runner events.');
    if (this.focus?.state === state && typeof events.droppedNotifications === 'number' && events.droppedNotifications > 0) {
      this.output.appendLine('Some live output was omitted. Open the runner again to read its saved history.');
    }
    for (const notification of Array.isArray(events.notifications) ? events.notifications : []) {
      if (!record(notification) || !record(notification.params)) continue;
      const params = notification.params;
      if (notification.method === 'thread/closed' && typeof params.threadId === 'string') {
        state.attached.delete(params.threadId);
        state.threads.delete(params.threadId);
      }
      if (this.focus?.state !== state || params.threadId !== this.focus.runner.id) continue;
      if (['item/agentMessage/delta', 'item/commandExecution/outputDelta'].includes(String(notification.method))
        && typeof params.delta === 'string') this.output.append(params.delta);
      if (notification.method === 'turn/completed' && record(params.turn)) this.output.appendLine(`\nRunner turn ${String(params.turn.status)}.`);
    }
  }

  private watch(state: RunnerState): void {
    if (state.polling || state.timer || !state.threads.size) return;
    state.polling = this.poll(state).finally(() => {
      state.polling = undefined;
      if (this.states.get(bindingKey(state.workspace.binding)) !== state || !state.threads.size) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(state.failures, 5));
      state.timer = setTimeout(() => { state.timer = undefined; this.watch(state); }, delay);
      state.timer.unref();
    });
  }

  private async poll(state: RunnerState): Promise<void> {
    let connection: RunnerConnection | undefined;
    try {
      connection = await this.useConnection(state);
      for (const runner of state.threads.values()) await this.attach(state, connection, runner);
      if (state.refreshHistory && this.focus?.state === state) {
        const focus = this.focus;
        const thread = await this.read(state, connection, focus.runner);
        if (this.focus === focus) this.showHistory(focus.runner, thread);
      }
      state.refreshHistory = false;
      const events = await this.request(state, connection, { kind: 'runner_events' });
      this.display(state, events);
      state.failures = 0;
      if (record(events) && Array.isArray(events.approvals)) for (const request of events.approvals) {
        if (!record(request)) continue;
        const key = JSON.stringify(request.id);
        if (state.announced.has(key)) continue;
        state.announced.add(key);
        if (state.announced.size > 256) state.announced.delete(state.announced.values().next().value!);
        const reviewedConnection = connection;
        void vscode.window.showInformationMessage('A runner command is waiting for approval.', 'Review').then(action => {
          if (action === 'Review') return this.reviewConnection(state, reviewedConnection);
        }).then(undefined, () => {});
      }
    } catch {
      if (this.states.get(bindingKey(state.workspace.binding)) !== state || connection && state.connection !== connection) return;
      if (state.failures++ === 0 && this.focus?.state === state) {
        this.output.appendLine('Runner updates are unavailable. Retrying the connection automatically.');
      }
    }
  }

  async reset(): Promise<void> {
    this.generation++;
    for (const state of this.states.values()) clearTimeout(state.timer);
    this.states.clear();
    this.focus = undefined;
    await this.connection.reset();
  }

  async shutdown(): Promise<void> { await this.reset(); await this.connection.shutdown(); this.output.dispose(); }
}
