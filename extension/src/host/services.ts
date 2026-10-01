import * as vscode from "vscode";
import { PeerAwarenessHost } from "../presence";
import { CaptureHost } from "../capture";
import { HistoryHost } from "../history";
import { HostConfiguration } from "./configuration";
import { HostCredentials } from "./credentials";
import type { DevTunnelsAdapters } from "./devTunnels";
import { HostDiagnostics } from "./diagnostics";
import { HostEffects } from "./effects";
import { NativeServices } from "./nativeServices";
import { HostError, record, textParam } from "./protocol";
import { TunnelJournal } from "./tunnelJournal";
import { bridgeDuplex, consumeTransport, writeTransport } from "./transport";

/** Extension-lifetime platform services consumed by capture, history and Rust effects. */
export class HostServices implements vscode.Disposable {
  readonly configuration: HostConfiguration;
  readonly credentials: HostCredentials;
  readonly diagnostics = new HostDiagnostics();
  readonly effects = new HostEffects(() => vscode.workspace.isTrusted);
  readonly presence = new PeerAwarenessHost(this.diagnostics);
  readonly native: NativeServices;
  readonly capture: CaptureHost;
  readonly history: HistoryHost;
  /** Byte adapters; the caller/Rust runtime owns protocol interpretation. */
  readonly transport = { bridgeDuplex, consumeTransport, writeTransport };
  private tunnels: Promise<DevTunnelsAdapters> | undefined;
  private readonly journals = new Map<DevTunnelsAdapters, TunnelJournal>();
  private readonly retiring = new Set<Promise<void>>();
  private closed = false;
  private shutdownWork: Promise<void> | undefined;
  private readonly accountChanged: vscode.Disposable;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configuration = new HostConfiguration(context.extensionUri.fsPath);
    this.credentials = new HostCredentials(context.secrets, () => vscode.workspace.isTrusted);
    this.native = new NativeServices(this.configuration);
    this.capture = new CaptureHost(context, this.configuration, this.diagnostics);
    this.history = new HistoryHost(context.extensionUri.fsPath, this.effects, this.diagnostics);
    const refreshCaptureAccount = () => { void this.capture.refreshAccount(async () => (await this.credentials.account())?.label); };
    refreshCaptureAccount();
    this.accountChanged = this.credentials.onDidChange(() => {
      this.capture.useAccount(undefined);
      refreshCaptureAccount();
      this.presence.disconnect();
      this.history.disconnect();
      this.retireTunnels();
    });
    this.registerPlatformEffects();
  }

  /** Called only from trusted native adapters. SDKs, tokens and connection grants stay here. */
  devTunnels(): Promise<DevTunnelsAdapters> {
    if (this.closed) return Promise.reject(new HostError("host_closed", "The extension host is shutting down."));
    this.configuration.assertTrusted();
    if (!this.tunnels) {
      const opening = this.openTunnels();
      this.tunnels = opening;
      void opening.catch(() => { if (this.tunnels === opening) this.tunnels = undefined; });
    }
    return this.tunnels;
  }

  private async openTunnels(): Promise<DevTunnelsAdapters> {
    const account = await this.credentials.account();
    if (!account) throw new HostError("authentication_required", "Run Idle: Sign In to GitHub first.");
    const { DevTunnelsAdapters: Adapters } = await import("./devTunnels/index.js");
    if (this.closed) throw new HostError("host_closed", "The extension host is shutting down.");
    const journal = new TunnelJournal(this.context.globalState, account.id);
    const adapters = new Adapters({
      githubToken: this.credentials.tokenProvider(account.id),
      journal,
    });
    this.journals.set(adapters, journal);
    return adapters;
  }

  /** Cleanup uses only resource markers recorded for the currently authorized account. */
  async cleanupTunnels(): Promise<void> {
    const account = await this.credentials.account();
    if (!account) throw new HostError("authentication_required", "Run Idle: Sign In to GitHub first.");
    const adapters = await this.devTunnels();
    const markers = this.journals.get(adapters)?.inactiveMarkers() ?? [];
    for (const marker of markers) await adapters.cleanup(marker);
    await this.diagnostics.notify("info", `Cleaned up ${markers.length} inactive Dev Tunnel resources.`);
  }

  private retireTunnels(): void {
    const tunnels = this.tunnels;
    this.tunnels = undefined;
    if (!tunnels) return;
    const work = tunnels.then(async adapters => {
      try { await adapters.shutdown(); }
      finally { await this.journals.get(adapters)?.release(); this.journals.delete(adapters); }
    }).catch(error => {
      this.diagnostics.failure("Closing Dev Tunnels", error);
    });
    this.retiring.add(work);
    void work.finally(() => this.retiring.delete(work));
  }

  private registerPlatformEffects(): void {
    this.effects.register("host.ready", () => ({ capabilities: this.effects.available(), configuration: this.configuration.snapshot() }), false);
    this.effects.register("configuration.read", () => this.configuration.snapshot(), false);
    this.effects.register("output.show", () => this.diagnostics.show(), false);
    this.effects.register("notification.show", async params => {
      const message = textParam(params, "message");
      const level = record(params) ? params.level : undefined;
      if (level !== "info" && level !== "warning" && level !== "error") throw new HostError("invalid_request", "Invalid notification level.");
      await this.diagnostics.notify(level, message);
    }, false);
    this.effects.register("clipboard.write", params => vscode.env.clipboard.writeText(textParam(params, "text", 1024 * 1024)));
    this.effects.register("external.open", async params => {
      const raw = textParam(params, "url");
      let url: URL;
      try { url = new URL(raw); } catch { throw new HostError("invalid_request", "Invalid external URL."); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        throw new HostError("denied", "Only HTTP(S) links without embedded credentials can be opened.");
      }
      if (!await vscode.env.openExternal(vscode.Uri.parse(url.href))) throw new HostError("cancelled", "The link was not opened.");
    });
  }

  async shutdown(): Promise<void> {
    return this.shutdownWork ??= this.close();
  }

  private async close(): Promise<void> {
    this.closed = true;
    this.accountChanged.dispose();
    this.presence.dispose();
    this.effects.dispose();
    this.retireTunnels();
    try { await Promise.all([this.capture.shutdown(), this.history.shutdown(), this.native.shutdown(), ...this.retiring]); }
    finally { this.credentials.dispose(); }
  }

  dispose(): void {
    void this.shutdown().catch(error => this.diagnostics.failure("Host shutdown", error)).finally(() => this.diagnostics.dispose());
  }
}
