import * as vscode from 'vscode';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { HostConfiguration } from '../host/configuration';
import { HostDiagnostics } from '../host/diagnostics';
import { StdioClient } from '../host/processes';
import { NativeServices } from '../host/nativeHost';
import { record } from '../host/protocol';
import { CollectorLoop, Update } from './loop';

interface Entry { loop: CollectorLoop; client: StdioClient }

/** Folder-owned collection continues when every application document is closed. */
export class CollectionHost implements vscode.Disposable {
  private entries: Entry[] = [];
  private generation = 0;
  private closed = false;
  private lifecycle = Promise.resolve();
  private readonly installed: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly configuration: HostConfiguration,
    private readonly diagnostics: HostDiagnostics, private readonly native: NativeServices) {
    this.installed.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.restart(); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.restart(); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (['live', 'chainDirectory'].some(key => event.affectsConfiguration(`idle.${key}`))) void this.restart();
      }),
      vscode.commands.registerCommand('idle.history.startImport', () => this.setEnabled(true)),
      vscode.commands.registerCommand('idle.history.pauseImport', () => this.setEnabled(false)),
    );
    void this.restart();
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    this.configuration.assertTrusted();
    await vscode.workspace.getConfiguration('idle').update('live.enabled', enabled, vscode.ConfigurationTarget.Workspace);
    await this.restart();
  }

  restart(): Promise<void> {
    const generation = ++this.generation;
    for (const entry of this.entries) entry.loop.stop();
    this.lifecycle = this.lifecycle.then(async () => {
      await this.stopEntries();
      if (this.closed || generation !== this.generation || !vscode.workspace.isTrusted || !this.context.storageUri) return;
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try { this.start(folder, generation); }
        catch (error) { this.diagnostics.failure(`History collection for ${folder.name}`, error); }
      }
    }).catch(error => this.diagnostics.failure('History collection restart', error));
    return this.lifecycle;
  }

  private start(folder: vscode.WorkspaceFolder, generation: number): void {
    const config = this.configuration.forResource(folder.uri);
    const settings = vscode.workspace.getConfiguration('idle', folder.uri);
    const extension = this.context.extensionUri.fsPath;
    const sessions = path.resolve(config.cwd, settings.get<string>('live.sessionsPath', '') ||
      path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions'));
    const helper = settings.get<string>('live.codexHelperPath', '') ||
      path.join(extension, 'bin', `${process.platform}-${process.arch}`, `codex-session-exporter${process.platform === 'win32' ? '.exe' : ''}`);
    if (!path.isAbsolute(helper)) throw new Error('Configure an absolute Codex exporter path on the workspace host.');
    const importing = settings.get<boolean>('live.enabled', true);
    const client = new StdioClient({}, this.native.connection(config.cwd, 'collection', {
      workspace: config.cwd, chain: config.chainDirectory, sessions, helper,
    }));
    client.setLog(line => this.diagnostics.append(`[collector ${folder.name}] ${line}`));
    const current = () => !this.closed && generation === this.generation && vscode.workspace.isTrusted &&
      !!vscode.workspace.getWorkspaceFolder(folder.uri);
    const request = async (body: unknown, signal: AbortSignal): Promise<Update> => {
      if (!current()) throw new Error('History collection binding was retired.');
      const restarted = !client.isRunning();
      client.ensureStarted();
      let result: unknown;
      try { result = await client.request(body, { signal, timeoutMs: 60000 }); }
      catch (error) { client.stop(); throw error; }
      if (!current()) throw new Error('History collection binding was retired.');
      if (!record(result) || !record(result.Ok) || typeof result.Ok.changed !== 'boolean' || typeof result.Ok.pending !== 'boolean') {
        throw new Error(record(result) && typeof result.Err === 'string' ? result.Err : 'Invalid collector response.');
      }
      return { ...result.Ok, changed: result.Ok.changed || restarted } as unknown as Update;
    };
    const loop = new CollectorLoop({
      poll: signal => request({ scan: importing ? 'import' : 'observe' }, signal),
      observe: signal => request({ paths: [], git_changed: false }, signal),
      changed: () => { if (current()) this.changed.fire(folder.uri); },
      failed: error => this.diagnostics.failure(`History collection for ${folder.name}`, error),
    });
    this.entries.push({ loop, client });
    loop.wake();
  }

  private async stopEntries(): Promise<void> {
    const entries = this.entries.splice(0);
    for (const entry of entries) entry.loop.stop();
    await Promise.all(entries.map(async entry => {
      try { await entry.client.shutdown(); } finally { await entry.loop.stopped(); }
    }));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.generation++;
    for (const installed of this.installed.splice(0)) installed.dispose();
    for (const entry of this.entries) entry.loop.stop();
    await this.lifecycle;
    await this.stopEntries();
    this.changed.dispose();
  }

  dispose(): void { void this.shutdown().catch(error => this.diagnostics.failure('History collection shutdown', error)); }
}
