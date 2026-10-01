import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { resolveFolder } from "../host/configuration";
import type { HostDiagnostics } from "../host/diagnostics";
import { HostError } from "../host/protocol";
import type { AwarenessView, CheckoutBinding, EditorContext, JoinOffer, Peer, PeerAwarenessProvider } from "./contracts";
import { branchLabel, label, offerLabel, peerLabel } from "./display";
import { EditorObservation, relativeFile } from "./editor";

export type { AwarenessView, CheckoutBinding, EditorContext, JoinRequest, PeerAwarenessProvider } from "./contracts";

interface Connection {
  binding: CheckoutBinding;
  provider: PeerAwarenessProvider;
  abort: AbortController;
  subscriptions: vscode.Disposable[];
  observer: EditorObservation;
  serial: number;
  running: boolean;
  dirty: boolean;
}
interface Choice extends vscode.QuickPickItem { offer?: JoinOffer }

/** Native editor UI and observation lifetime; Rust/provider code owns domain decisions. */
export class PeerAwarenessHost implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 5);
  private connection: Connection | undefined;
  private view: AwarenessView | undefined;
  private expiresAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly joining = new Map<string, AbortController>();
  private closed = false;

  constructor(private readonly diagnostics: HostDiagnostics) {
    this.status.name = "Idle file peers";
    this.status.command = "idle.presence.showPeers";
    this.subscriptions = [
      vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "vscode-remote" }], this),
      vscode.commands.registerCommand("idle.presence.showPeers", (connection?: unknown) =>
        diagnostics.command("Show file peers", () => this.showPeers(typeof connection === "string" ? connection : undefined))),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.disconnect()),
    ];
  }

  /** Replace the explicitly selected binding. No authentication/network work occurs until installed. */
  connect(binding: CheckoutBinding, provider: PeerAwarenessProvider): vscode.Disposable {
    if (this.closed) throw new HostError("host_closed", "The extension host is shutting down.");
    if (!vscode.workspace.isTrusted) throw new HostError("workspace_untrusted", "Trust this workspace before sharing presence.");
    resolveFolder(binding.root);
    if (!binding.context.binding.workspace_id || !binding.context.binding.repository_id || !binding.context.binding.chain ||
        !binding.context.contributor_id || !binding.context.connection_id || binding.root.query || binding.root.fragment) {
      throw new HostError("invalid_request", "Presence requires an explicit workspace, repository and contributor.");
    }
    this.disconnect();
    const connection: Connection = {
      binding: { root: binding.root, context: structuredClone(binding.context) }, provider,
      abort: new AbortController(), subscriptions: [], serial: 0, running: false, dirty: false,
      observer: new EditorObservation(binding.root, () => this.schedule(connection), error => this.diagnostics.failure("Observe Git branch", error)),
    };
    this.connection = connection;
    connection.subscriptions.push(provider.onDidChange(() => this.schedule(connection)));
    this.schedule(connection);
    return { dispose: () => { if (this.connection === connection) this.disconnect(); } };
  }

  /** Called on account/configuration changes and provider selection/recovery teardown. */
  disconnect(): void {
    const connection = this.connection;
    this.connection = undefined;
    connection?.abort.abort();
    connection?.observer.dispose();
    for (const subscription of connection?.subscriptions ?? []) subscription.dispose();
    this.clear();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.view = undefined;
    this.expiresAt = 0;
    for (const abort of this.joining.values()) abort.abort();
    this.joining.clear();
    this.status.hide();
    this.changed.fire();
  }

  private schedule(connection: Connection): void {
    if (this.connection !== connection || connection.abort.signal.aborted) return;
    if (!vscode.workspace.isTrusted) { this.disconnect(); return; }
    connection.serial++;
    connection.dirty = true;
    this.clear();
    if (!connection.running) void this.refresh(connection);
  }

  private editor(connection: Connection): EditorContext {
    return { ...structuredClone(connection.binding.context), ...connection.observer.current() };
  }

  private async refresh(connection: Connection): Promise<void> {
    connection.running = true;
    try {
      while (connection.dirty && this.connection === connection && !connection.abort.signal.aborted) {
        connection.dirty = false;
        const serial = connection.serial;
        const editor = this.editor(connection);
        const started = performance.now();
        try {
          const supplied = await connection.provider.update(editor, connection.abort.signal);
          if (this.connection !== connection || connection.serial !== serial || connection.abort.signal.aborted) continue;
          if (!vscode.workspace.isTrusted) { this.disconnect(); return; }
          if (!sameEditor(supplied.editor, editor) || !Number.isSafeInteger(supplied.valid_for_ms) || supplied.valid_for_ms <= 0) {
            throw new HostError("invalid_presence", "The presence provider returned an invalid editor context or lifetime.");
          }
          const expiresAt = started + Math.min(supplied.valid_for_ms, 30_000);
          if (performance.now() >= expiresAt) throw new HostError("stale_presence", "The presence response expired before it arrived.");
          this.view = structuredClone(supplied);
          this.expiresAt = expiresAt;
          this.renderStatus();
          this.changed.fire();
          this.timer = setTimeout(() => this.schedule(connection), expiresAt - performance.now());
          this.timer.unref();
          void this.notifyBranches(connection, this.view).catch(error => this.diagnostics.failure("Branch invitation", error));
        } catch (error) {
          if (this.connection !== connection || connection.serial !== serial || connection.abort.signal.aborted) continue;
          this.clear();
          this.diagnostics.failure("Refresh peer awareness", error);
          this.timer = setTimeout(() => this.schedule(connection), 15_000);
          this.timer.unref();
        }
      }
    } finally { connection.running = false; }
  }

  private current(): AwarenessView | undefined {
    if (!vscode.workspace.isTrusted || !this.connection || performance.now() >= this.expiresAt ||
        !this.view || !sameEditor(this.view.editor, this.editor(this.connection))) return undefined;
    return this.view;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const view = this.current();
    if (!view || !this.connection || !view.editor.file || relativeFile(this.connection.binding.root, document.uri) !== view.editor.file) return [];
    return view.peers.map(peer => new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      command: "idle.presence.showPeers", arguments: [peer.connection_id],
      title: `${peerLabel(peer)}${peer.summary ? ` · ${label(peer.summary)}` : ""}`,
      tooltip: peer.summary ? `Supplied work summary: ${label(peer.summary)}. Show join choices.` : "Show peer details and join choices.",
    }));
  }

  private renderStatus(): void {
    const count = this.view?.peers.length ?? 0;
    if (!count) { this.status.hide(); return; }
    this.status.text = `$(organization) Idle: ${count} ${count === 1 ? "peer" : "peers"}`;
    this.status.tooltip = "People working on this file — show branches, hosts and join choices";
    this.status.show();
  }

  async showPeers(connectionId?: string): Promise<void> {
    const view = this.current();
    if (!view) {
      await this.diagnostics.notify("info", this.connection
        ? "Peer awareness is unavailable for this workspace. Try again shortly."
        : "Peer awareness is unavailable. Connect to a workspace to see file peers.");
      return;
    }
    const peers = view.peers.filter(peer => !connectionId || peer.connection_id === connectionId);
    if (!peers.length) { await this.diagnostics.notify("info", "No peers are currently reporting work on this file."); return; }
    await this.choose(peers, view);
  }

  private async choose(peers: Peer[], view: AwarenessView): Promise<void> {
    const choices: Choice[] = peers.flatMap(peer => peer.joins.length ? peer.joins.map(offer => ({
      label: offerLabel(offer), description: peerLabel(peer), detail: label(peer.summary ?? "No work summary supplied."), offer,
    })) : [{ label: peerLabel(peer), detail: label(peer.summary ?? "No work summary supplied."), description: "No join invitation is currently available" }]);
    const choice = await vscode.window.showQuickPick(choices, { title: "Idle peer invitations", matchOnDescription: true, matchOnDetail: true });
    if (choice?.offer) await this.join(choice.offer, view);
  }

  private async notifyBranches(connection: Connection, view: AwarenessView): Promise<void> {
    // One prompt per update, even if several peers converged on the branch together.
    const first = view.invitations[0];
    if (!first || this.connection !== connection || this.current() !== view) return;
    const extra = view.invitations.length > 1 ? ` (${view.invitations.length} peers on this branch.)` : "";
    const title = "Show join choices";
    const result = await vscode.window.showInformationMessage(branchLabel(first) + extra,
      ...(view.invitations.some(invitation => invitation.peer.joins.length) ? [title] : []));
    if (result === title && this.connection === connection && this.current() === view) {
      await this.diagnostics.command("Join branch peer", () => this.choose(view.invitations.map(invitation => invitation.peer), view));
    }
  }

  private async join(offer: JoinOffer, view: AwarenessView): Promise<void> {
    const connection = this.connection;
    if (!connection || this.current() !== view) throw new HostError("stale_invitation", "This invitation changed. Open the peer list again.");
    const request = offer.request;
    if (request.mode !== view.editor.mode || request.contributor_id !== view.editor.contributor_id ||
        request.binding.workspace_id !== view.editor.binding.workspace_id || request.binding.repository_id !== view.editor.binding.repository_id ||
        request.binding.chain !== view.editor.binding.chain || !request.grant_id ||
        ![...view.peers, ...view.invitations.map(invitation => invitation.peer)]
          .some(peer => peer.connection_id === request.connection_id && peer.joins.includes(offer))) {
      throw new HostError("invalid_invitation", "This invitation does not belong to the selected workspace and contributor.");
    }
    const key = JSON.stringify(offer.request);
    if (this.joining.has(key)) return;
    const abort = new AbortController();
    this.joining.set(key, abort);
    try {
      const outcome = await connection.provider.join(structuredClone(offer.request), abort.signal);
      if (abort.signal.aborted || this.connection !== connection || this.current() !== view) return;
      if (outcome !== "connected" && outcome !== "pending") throw new HostError("invalid_join", "The provider returned an unknown join result.");
      await this.diagnostics.notify("info", outcome === "connected"
        ? `Joined ${offer.request.target.kind}: ${label(offer.label)}.`
        : `Join requested for ${label(offer.label)}; waiting for the runtime connection.`);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally { if (this.joining.get(key) === abort) this.joining.delete(key); }
  }

  dispose(): void {
    this.closed = true;
    this.disconnect();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.status.dispose();
    this.changed.dispose();
  }
}

function sameEditor(left: EditorContext, right: EditorContext): boolean {
  return left.binding.workspace_id === right.binding.workspace_id && left.binding.repository_id === right.binding.repository_id &&
    left.binding.chain === right.binding.chain && left.mode === right.mode && left.contributor_id === right.contributor_id &&
    left.connection_id === right.connection_id && left.host_id === right.host_id && left.file === right.file && left.branch === right.branch;
}
