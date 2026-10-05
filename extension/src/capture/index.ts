import * as vscode from 'vscode';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { HostConfiguration } from '../host/configuration';
import { HostDiagnostics } from '../host/diagnostics';
import { StdioClient } from '../host/processes';
import { NativeServices } from '../host/nativeHost';
import { EditorCapture, EditorRevision } from './editorCapture';
import { EditorOutbox } from './editorOutbox';
import { EditorHealth } from './editorHealth';
import { observeEditorContext } from './editorContext';
import { unsignedIdentity, workspaceIdentity } from './humanIdentity';
import { HistoryArchive, archiveDirectory } from './historyArchive';
import { MAX_EDITOR_BUFFER_BYTES } from './editorLimits';

const SETTINGS = ['tracking', 'chainDirectory'];
type Recorder = { folder: vscode.WorkspaceFolder; capture: EditorCapture; outbox: EditorOutbox;
  context: vscode.Disposable; clients: StdioClient[]; health: EditorHealth };

/** Human capture belongs to activation, including when every Idle view is closed. */
export class CaptureHost implements vscode.Disposable {
  private recorders: Recorder[] = [];
  private lifecycle = Promise.resolve();
  private stopping: Promise<void> | undefined;
  private closed = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly archives = new Map<string, HistoryArchive>();
  private archive: HistoryArchive | undefined;
  private readonly status: vscode.StatusBarItem;
  private name: string | undefined;
  private accountGeneration = 0;
  private trackingUpdates = Promise.resolve();
  private trackingGeneration = 0;
  private trackingBlocked = false;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly configuration: HostConfiguration,
    private readonly diagnostics: HostDiagnostics,
    private readonly native: NativeServices,
    private readonly client?: () => StdioClient) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    this.status.name = 'Idle capture';
    this.status.command = 'idle.tracking.status';
    this.subscriptions.push(this.status,
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.restart(); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.restart(); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (SETTINGS.some(setting => event.affectsConfiguration(`idle.${setting}`))) void this.restart();
      }),
      vscode.commands.registerCommand('idle.tracking.start', () => this.setTracking(true)),
      vscode.commands.registerCommand('idle.tracking.stop', () => this.setTracking(false)),
      vscode.commands.registerCommand('idle.tracking.status', () => { this.diagnostics.show(); return this.snapshot(); }),
    );
    void this.restart();
  }

  /** Return capture health without opening a view. */
  async snapshot(): Promise<unknown> {
    await this.lifecycle;
    return this.recorders.map(({ folder, health }) => ({ workspace: folder.uri.toString(), ...health }));
  }

  /** Current capture identity, including unsaved buffer versions. */
  revision(document: vscode.TextDocument): EditorRevision | undefined {
    for (const recorder of this.recorders) {
      const revision = recorder.capture.revision(document);
      if (revision) return revision;
    }
    return undefined;
  }

  /** Receipt display metadata remains unsigned and never rewrites earlier changes. */
  useAccount(label: string | undefined): void {
    this.accountGeneration++;
    const trimmed = label?.trim();
    this.name = trimmed && [...trimmed].length <= 80 && !/\p{Cc}/u.test(trimmed) ? trimmed : undefined;
    for (const recorder of this.recorders) recorder.capture.setUserName(this.name);
  }

  /** Existing account labels are optional; capture never prompts for authentication. */
  async refreshAccount(read: () => Promise<string | undefined>): Promise<void> {
    const generation = ++this.accountGeneration;
    await this.lifecycle;
    if (this.closed || !vscode.workspace.isTrusted || !this.recorders.length) return;
    try {
      const label = await read();
      if (!this.closed && vscode.workspace.isTrusted && generation === this.accountGeneration) this.useAccount(label);
    } catch {
      if (generation === this.accountGeneration) this.useAccount(undefined);
    }
  }

  private async setTracking(enabled: boolean): Promise<void> {
    this.configuration.assertTrusted();
    const generation = ++this.trackingGeneration;
    // Stop reads before asynchronous settings writes, including failed writes.
    this.trackingBlocked = true;
    void this.restart();
    const update = this.trackingUpdates.then(async () => {
      this.configuration.assertTrusted();
      await vscode.workspace.getConfiguration('idle').update('tracking.enabled', enabled, vscode.ConfigurationTarget.Workspace);
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const settings = vscode.workspace.getConfiguration('idle', folder.uri);
        if (settings.inspect<boolean>('tracking.enabled')?.workspaceFolderValue !== undefined) {
          await settings.update('tracking.enabled', enabled, vscode.ConfigurationTarget.WorkspaceFolder);
        }
      }
      if (generation === this.trackingGeneration) this.trackingBlocked = false;
      await this.restart();
    });
    this.trackingUpdates = update.catch(() => {});
    return update;
  }

  restart(): Promise<void> {
    // Stop editor listeners immediately; disk/native cleanup may take longer.
    for (const recorder of this.recorders) {
      recorder.context.dispose();
      recorder.capture.dispose('Recorder configuration or workspace changed; work until the next baseline may be unobserved.');
    }
    this.lifecycle = this.lifecycle.then(async () => {
      await this.stopRecorders();
      if (this.closed || !vscode.workspace.isTrusted || !this.context.storageUri || !this.context.globalStorageUri) {
        this.updateStatus(vscode.workspace.isTrusted ? 'Capture unavailable in this window' : 'Capture requires Workspace Trust');
        return;
      }
      await this.syncArchive();
      if (this.closed || !vscode.workspace.isTrusted) return;
      const folders = vscode.workspace.workspaceFolders ?? [];
      const enabled = folders.filter(folder => this.enabled(folder));
      if (!enabled.length) { this.updateStatus('Capture paused'); return; }
      const guid = await unsignedIdentity(this.context.globalStorageUri.fsPath);
      if (this.closed || !vscode.workspace.isTrusted) return;
      for (const folder of enabled) {
        if (this.enabled(folder)) this.startRecorder(folder, guid, folders.length === 1);
      }
      this.updateStatus(this.recorders.length ? 'Tracking editor work' : 'Capture paused');
    }).catch(error => this.updateStatus(`Capture pending: ${String(error)}`));
    return this.lifecycle;
  }

  private enabled(folder: vscode.WorkspaceFolder): boolean {
    const native = folder.uri.scheme === 'file' || (folder.uri.scheme === 'vscode-remote' && !!vscode.env.remoteName);
    return !this.closed && !this.trackingBlocked && vscode.workspace.isTrusted && native
      && (vscode.workspace.workspaceFolders ?? []).some(current => current.uri.toString() === folder.uri.toString())
      && vscode.workspace.getConfiguration('idle', folder.uri).get<boolean>('tracking.enabled', true);
  }

  private startRecorder(folder: vscode.WorkspaceFolder, guid: string, untitled: boolean): void {
    const config = this.configuration.forResource(folder.uri);
    const settings = vscode.workspace.getConfiguration('idle', folder.uri);
    const connect = this.native.connection(config.cwd, 'capture', { workspace_path: config.cwd, chain_dir: config.chainDirectory });
    const create = this.client ?? (() => new StdioClient({}, connect));
    const clients = [create(), create()];
    const [client, contextClient] = clients;
    for (const client of clients) client.setLog(line => this.diagnostics.append(`[capture] ${line}`));
    const start = (client: StdioClient) => {
      this.configuration.assertTrusted();
      if (!vscode.workspace.getWorkspaceFolder(folder.uri)) throw new Error('Capture folder is no longer open');
      client.ensureStarted();
    };
    const namespace = createHash('sha256').update(folder.uri.toString() + '\0' + config.chainDirectory).digest('hex');
    const directory = path.join(this.context.storageUri!.fsPath, 'editor-outbox', namespace);
    const archive = this.archive;
    const outbox = new EditorOutbox(directory, config.cwd, config.chainDirectory, body => {
      start(client); return client.requestJson(body, { timeoutMs: 30000 });
    }, message => this.updateStatus(message), () => { if (!this.closed) this.changed.fire(folder.uri); },
    timing => this.diagnostics.append(`[capture] delivery ${JSON.stringify(timing)}`),
    (workspace, event, raw) => archive?.append(workspace, event, raw));
    const health = new EditorHealth();
    const dwell = bounded(settings.get('tracking.readDwellMs', 2000), 500, 30000, 2000);
    const maxBytes = bounded(settings.get('tracking.maxFileBytes', MAX_EDITOR_BUFFER_BYTES), 1024, MAX_EDITOR_BUFFER_BYTES, MAX_EDITOR_BUFFER_BYTES);
    const capture = new EditorCapture(folder, dwell, maxBytes, event => {
      const accepted = outbox.push(event);
      if (accepted) health.observe(event);
      return accepted;
    }, workspaceIdentity(guid, folder.uri.toString(), config.cwd, config.chainDirectory), this.name,
    file => within(config.chainDirectory, file) || within(this.context.storageUri!.fsPath, file)
      || [...this.archives.values()].some(archive => archive.excludes(file)),
    () => this.enabled(folder), untitled);
    const context = observeEditorContext(capture, () => {
      start(contextClient);
      return contextClient.request({ GetEditorContext: { workspace_path: config.cwd, chain_dir: config.chainDirectory } }, { timeoutMs: 30000 });
    }, message => this.diagnostics.append(`[capture] ${message}`));
    this.recorders.push({ folder, capture, outbox, context, clients, health });
  }

  private async syncArchive(): Promise<void> {
    const settings = vscode.workspace.getConfiguration('idle');
    this.archive = undefined;
    if (!settings.get<boolean>('tracking.jsonl.enabled', false)) return;
    const roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => this.enabled(folder)).map(folder => folder.uri.fsPath);
    const destination = archiveDirectory(settings.get('tracking.jsonl.directory', ''), roots,
      path.join(this.context.globalStorageUri.fsPath, 'human-history'));
    if ('error' in destination) { this.reportArchive(destination.error); return; }
    let archive = this.archives.get(destination.directory);
    if (!archive) {
      archive = new HistoryArchive({ directory: destination.directory,
        log: line => this.diagnostics.append(line), report: message => this.reportArchive(message) });
      await archive.setup();
      this.archives.set(destination.directory, archive);
    }
    this.archive = archive;
  }

  private reportArchive(message: string): void {
    this.diagnostics.append(`[capture archive] ${message}`);
    if (!this.closed) void this.diagnostics.notify('error', `Idle capture archive: ${message}`);
  }

  private updateStatus(message: string): void {
    if (this.closed) return;
    this.status.text = '$(edit) Idle capture';
    this.status.tooltip = message;
    this.status.show();
    this.diagnostics.append(`[capture] ${message}`);
  }

  /** Flush admitted events; a false result leaves durable retries on disk. */
  async flush(): Promise<boolean> {
    await this.lifecycle;
    const results = await Promise.all(this.recorders.map(async recorder => {
      recorder.capture.checkpoint(); return recorder.outbox.flush();
    }));
    return results.every(Boolean);
  }

  private async stopRecorders(): Promise<void> {
    const recorders = this.recorders;
    this.recorders = [];
    for (const recorder of recorders) { recorder.context.dispose(); recorder.capture.dispose(); }
    await Promise.all(recorders.map(async recorder => {
      try { await recorder.outbox.stop(); }
      finally { await Promise.all(recorder.clients.map(client => client.shutdown())); }
    }));
  }

  shutdown(): Promise<void> {
    this.closed = true;
    this.changed.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const recorder of this.recorders) { recorder.context.dispose(); recorder.capture.dispose(); }
    this.stopping ??= this.close();
    return this.stopping;
  }

  private async close(): Promise<void> {
    await this.lifecycle;
    try { await this.stopRecorders(); }
    finally { await Promise.all([...this.archives.values()].map(archive => archive.stop())); }
  }

  dispose(): void { void this.shutdown().catch(error => this.diagnostics.failure('Capture shutdown', error)); }
}

function bounded(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

function within(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
