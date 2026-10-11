import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { bindingKey, RepositoryBinding } from '../history/contracts';
import { FolderConfiguration } from './configuration';
import { HostError, record } from './protocol';
import { RuntimeHost } from './runtime';

export interface RunnerWorkspace { config: FolderConfiguration; binding: RepositoryBinding }
interface SavedRunner { id: string; label: string }

/** Editor controls for native threads. Closing these controls leaves admitted work on the daemon. */
export class RunnerSessions {
  private readonly output = vscode.window.createOutputChannel('Idle Runners');
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private readonly announced = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext, readonly connection: RuntimeHost) {}

  async start(workspace: RunnerWorkspace, prompt: string): Promise<void> {
    this.validatePrompt(prompt);
    const started = await this.rpc(workspace, 'thread/start', {});
    if (!record(started) || !record(started.thread) || typeof started.thread.id !== 'string') {
      throw new HostError('invalid_data', 'The compute host did not return a runner.');
    }
    const id = started.thread.id;
    await this.remember(workspace, { id, label: prompt.slice(0, 100) });
    this.output.appendLine(`Runner started: ${id}`);
    this.output.show(true);
    this.watch(workspace);
    await this.rpc(workspace, 'turn/start', { threadId: id, input: [{ type: 'text', text: prompt }] });
  }

  async show(workspace: RunnerWorkspace): Promise<void> {
    const runner = await this.select(workspace);
    if (!runner) return;
    const response = await this.rpc(workspace, 'thread/resume', { threadId: runner.id });
    if (!record(response) || !record(response.thread)) throw new HostError('invalid_data', 'Runner history is unavailable.');
    await this.remember(workspace, runner);
    this.output.clear();
    this.output.appendLine(runner.label);
    this.history(response.thread);
    this.output.show(true);
    this.watch(workspace);
  }

  async send(workspace: RunnerWorkspace): Promise<void> {
    const runner = await this.select(workspace);
    if (!runner) return;
    const generation = this.generation;
    const prompt = await vscode.window.showInputBox({ title: 'Send to Runner', prompt: 'Describe the next task', ignoreFocusOut: true });
    if (generation !== this.generation) return;
    if (!prompt?.trim()) return;
    this.validatePrompt(prompt);
    await this.rpc(workspace, 'thread/resume', { threadId: runner.id, excludeTurns: true });
    this.watch(workspace);
    await this.rpc(workspace, 'turn/start', { threadId: runner.id, input: [{ type: 'text', text: prompt }] });
    this.output.show(true);
  }

  async interrupt(workspace: RunnerWorkspace): Promise<void> {
    const runner = await this.select(workspace);
    if (!runner) return;
    const response = await this.rpc(workspace, 'thread/read', { threadId: runner.id, includeTurns: true });
    const turns = record(response) && record(response.thread) ? response.thread.turns : undefined;
    const turn = Array.isArray(turns) ? turns.slice().reverse().find(value => record(value) && value.status === 'inProgress') : undefined;
    if (!record(turn) || typeof turn.id !== 'string') throw new HostError('invalid_request', 'This runner has no active turn.');
    await this.rpc(workspace, 'turn/interrupt', { threadId: runner.id, turnId: turn.id });
    this.output.appendLine('Runner interrupt requested.');
  }

  async review(workspace: RunnerWorkspace): Promise<void> {
    const generation = this.generation;
    const events = await this.connection.runner(workspace.config, workspace.binding, { kind: 'runner_events' });
    this.display(events);
    const approvals = record(events) && Array.isArray(events.approvals) ? events.approvals : [];
    const choices = approvals.filter(value => record(value) && record(value.params)).map(value => ({
      label: String(value.params.command ?? 'Runner command').slice(0, 160), request: value,
    }));
    if (!choices.length) { await vscode.window.showInformationMessage('No runner commands are waiting for approval.'); return; }
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose the command to review' });
    if (!selected) return;
    const { id, params } = selected.request;
    if ((typeof id !== 'string' && typeof id !== 'number') || !record(params)) throw new HostError('invalid_data', 'Invalid runner approval.');
    const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content:
      `# Working directory: ${String(params.cwd ?? '')}\n# Reason: ${String(params.reason ?? 'Command requires approval')}\n\n${String(params.command ?? '')}\n` });
    await vscode.window.showTextDocument(document, { preview: true });
    const decision = await vscode.window.showWarningMessage('Run the displayed command within this runner’s existing permissions?',
      { modal: true }, 'Run Command', 'Decline');
    if (!decision || generation !== this.generation) return;
    await this.connection.runner(workspace.config, workspace.binding,
      { kind: 'runner_approve', id, decision: decision === 'Run Command' ? 'accept' : 'decline' });
    this.output.appendLine('Command decision submitted.');
  }

  validatePrompt(prompt: string): void {
    if (Buffer.byteLength(prompt) > 32 * 1024) throw new HostError('invalid_request', 'Runner messages must be at most 32 KiB.');
  }

  private async rpc(workspace: RunnerWorkspace, method: string, params: unknown): Promise<unknown> {
    const value = await this.connection.runner(workspace.config, workspace.binding, { kind: 'runner', method, params });
    if (!record(value) || !record(value.response)) throw new HostError('invalid_data', 'Invalid runner response.');
    if (record(value.response.error)) {
      const message = value.response.error.message;
      throw new HostError('runner_request_failed', typeof message === 'string' ? message.slice(0, 2000) : 'The compute host rejected this runner request.');
    }
    return value.response.result;
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

  private history(thread: Record<string, unknown>): void {
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

  private display(events: unknown): void {
    if (!record(events)) throw new HostError('invalid_data', 'Invalid runner events.');
    if (typeof events.droppedNotifications === 'number' && events.droppedNotifications > 0) {
      this.output.appendLine('Some live output was omitted. Open the runner again to read its saved history.');
    }
    for (const notification of Array.isArray(events.notifications) ? events.notifications : []) {
      if (!record(notification) || !record(notification.params)) continue;
      const params = notification.params;
      if (['item/agentMessage/delta', 'item/commandExecution/outputDelta'].includes(String(notification.method))
        && typeof params.delta === 'string') this.output.append(params.delta);
      if (notification.method === 'turn/completed' && record(params.turn)) this.output.appendLine(`\nRunner turn ${String(params.turn.status)}.`);
    }
  }

  private watch(workspace: RunnerWorkspace): void {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const poll = async () => {
      if (generation !== this.generation) return;
      try {
        const events = await this.connection.runner(workspace.config, workspace.binding, { kind: 'runner_events' });
        if (generation !== this.generation) return;
        this.display(events);
        if (record(events) && Array.isArray(events.approvals)) for (const request of events.approvals) {
          if (!record(request)) continue;
          const key = `${bindingKey(workspace.binding)}:${String(request.id)}`;
          if (this.announced.has(key)) continue;
          this.announced.add(key);
          if (this.announced.size > 256) this.announced.delete(this.announced.values().next().value!);
          void vscode.window.showInformationMessage('A runner command is waiting for approval.', 'Review').then(action => {
            if (action === 'Review' && generation === this.generation) return this.review(workspace);
          }).then(undefined, () => {});
        }
      } catch {
        if (generation === this.generation) this.output.appendLine('Runner updates are unavailable. Reconnect to check the saved result.');
        return;
      }
      if (generation === this.generation) { this.timer = setTimeout(() => { void poll(); }, 1000); this.timer.unref(); }
    };
    void poll();
  }

  async reset(): Promise<void> { this.generation++; clearTimeout(this.timer); this.announced.clear(); await this.connection.reset(); }
  async shutdown(): Promise<void> { await this.reset(); await this.connection.shutdown(); this.output.dispose(); }
}
