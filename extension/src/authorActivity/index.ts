import * as vscode from 'vscode';
import type { CaptureHost } from '../capture';
import type { AssemblyHost } from '../host/assembly';
import type { HostDiagnostics } from '../host/diagnostics';
import { HostError, publicError } from '../host/protocol';
import { HistoryHost } from '../history';
import { HistoryRequest } from '../history/contracts';
import { TEXT_SCHEME, documentAddress } from '../history/documents';
import { ActivityPreview, ActivityRequest } from './contracts';
import { ActivityRenderer } from './render';

interface Shown { version: number; preview: ActivityPreview }

/** Extension-lifetime native decorations, independent of webview visibility. */
export class ActivityDecorations implements vscode.Disposable {
  private readonly renderer = new ActivityRenderer();
  private readonly installed: vscode.Disposable[];
  private readonly shown = new Map<vscode.TextDocument, Shown>();
  private editors = new Set<vscode.TextEditor>();
  private timer: NodeJS.Timeout | undefined;
  private abort = new AbortController();
  private generation = 0;
  private closed = false;

  constructor(private readonly history: HistoryHost, private readonly capture: CaptureHost,
    private readonly assembly: AssemblyHost, diagnostics: HostDiagnostics) {
    this.installed = [
      history.onDidChange(() => this.refresh()),
      capture.onDidChange(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) this.refresh(); }),
      vscode.workspace.onDidCloseTextDocument(() => this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('idle')) this.refresh(); }),
      vscode.commands.registerCommand('idle.activity.showSources', (uri?: unknown) => diagnostics.command('Author and exposure sources', () => this.showSources(uri))),
    ];
    this.refresh();
  }

  /** Capture, imports, replication and binding changes all invalidate pending reads. */
  refresh(): void {
    if (this.closed) return;
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.shown.clear();
    for (const editor of this.editors) this.renderer.clear(editor);
    this.editors = new Set(vscode.window.visibleTextEditors);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update(this.generation, this.abort.signal);
    }, 100);
    this.timer.unref();
  }

  private enabled(document: vscode.TextDocument): boolean {
    return !this.closed && vscode.workspace.isTrusted &&
      (document.uri.scheme === TEXT_SCHEME || document.isUntitled && vscode.workspace.workspaceFolders?.length === 1 ||
        !!vscode.workspace.getWorkspaceFolder(document.uri)) &&
      vscode.workspace.getConfiguration('idle', document.uri).get('decorations.enabled', true);
  }

  private async update(generation: number, signal: AbortSignal): Promise<void> {
    const documents = new Set([...this.editors].map(editor => editor.document));
    for (const document of documents) {
      if (signal.aborted) return;
      if (!this.enabled(document) || !['file', 'vscode-remote', 'untitled', TEXT_SCHEME].includes(document.uri.scheme)) continue;
      await this.read(document, generation, signal);
    }
  }

  private selection(document: vscode.TextDocument): { request: ActivityRequest; connection?: string } {
    if (document.uri.scheme === TEXT_SCHEME) {
      const address = documentAddress(document.uri);
      if (!(address.request.target === 'File' && address.part === 0 || address.request.target === 'Diff' && address.part === 1)) {
        throw new HostError('unavailable', 'Author and exposure decorations require a recorded resulting file revision. This document has no selected revision.');
      }
      return { connection: address.connection, request: { binding: address.request.binding, source: address.request.source,
        selection: { Record: address.request.record } } };
    }
    const revision = this.capture.revision(document);
    if (!revision) throw new HostError('not_recorded', 'This buffer has no active captured revision. Author and exposure observations are unknown.');
    const resource = document.isUntitled ? vscode.workspace.workspaceFolders?.[0]?.uri : document.uri;
    if (!resource) throw new HostError('unavailable', 'This document has no repository binding.');
    return { request: { binding: this.assembly.ensureBindingFor(resource), source: 'current', selection: { Editor: revision } } };
  }

  private async read(document: vscode.TextDocument, generation: number, signal: AbortSignal): Promise<void> {
    const version = document.version;
    const current = () => !signal.aborted && generation === this.generation && document.version === version && this.enabled(document);
    try {
      const { request, connection } = this.selection(document);
      const preview = await this.history.activity(request, signal, connection);
      if (!current()) return;
      if (preview.text !== document.getText()) throw new HostError('revision_mismatch', 'The displayed buffer differs from the recorded snapshot. Author and exposure ranges are unavailable for this content.');
      this.shown.set(document, { version, preview });
      for (const editor of this.editors) if (editor.document === document) this.renderer.show(editor, preview);
    } catch (error) {
      if (!current()) return;
      for (const editor of this.editors) if (editor.document === document) this.renderer.status(editor, publicError(error).message);
    }
  }

  private async showSources(uri?: unknown): Promise<void> {
    const document = typeof uri === 'string' ? [...this.shown.keys()].find(document => document.uri.toString() === uri)
      : vscode.window.activeTextEditor?.document;
    const shown = document && this.shown.get(document);
    if (!document || !this.enabled(document) || !shown || shown.version !== document.version) {
      throw new HostError('unavailable', 'Source observations are unavailable for the active buffer revision.');
    }
    const generation = this.generation;
    const preview = shown.preview;
    const choices: (vscode.QuickPickItem & { request: HistoryRequest })[] = [];
    const seen = new Set<string>();
    for (const indicator of preview.indicators) for (const source of indicator.sources) {
      const key = JSON.stringify(source.record);
      if (seen.has(key)) continue;
      seen.add(key);
      const targets = source.original ? ['Record', 'Original'] as const : ['Record'] as const;
      for (const target of targets) choices.push({ label: `${target}: ${indicator.label}`,
        description: source.record.operation.slice(0, 12), detail: source.record.operation,
        request: { binding: preview.request.binding, source: preview.request.source, record: source.record, target } });
    }
    choices.unshift(...(['File', 'Diff'] as const).map(target => ({ label: `Open recorded ${target.toLowerCase()}`,
      description: preview.record.operation.slice(0, 12),
      request: { binding: preview.request.binding, source: preview.request.source, record: preview.record, target } })));
    const picked = await vscode.window.showQuickPick(choices, { title: 'Author and exposure source records', matchOnDescription: true, matchOnDetail: true });
    if (picked && generation === this.generation && this.enabled(document) && document.version === shown.version) {
      await vscode.commands.executeCommand(`idle.history.open${picked.request.target}`, picked.request);
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    for (const editor of this.editors) this.renderer.clear(editor);
    this.editors.clear();
    this.shown.clear();
    for (const installed of this.installed) installed.dispose();
    this.renderer.dispose();
  }
}
