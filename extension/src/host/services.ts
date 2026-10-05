import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { PeerAwarenessHost } from "../presence";
import { CaptureHost } from "../capture";
import { CollectionHost } from "../collection";
import { SharingHost } from "../sharing";
import { HistoryHost } from "../history";
import { ActivityDecorations } from "../authorActivity";
import { HostConfiguration } from "./configuration";
import { NativeHost } from "./nativeHost";
import { CoordinationHost } from "./coordination";
import { RepositoryHost } from "./repository";
import { AssemblyHost } from "./assembly";
import { HostCredentials } from "./credentials";
import { HostDiagnostics } from "./diagnostics";
import { HostEffects } from "./effects";
import { HostError, publicError, record, textParam } from "./protocol";
import { bridgeDuplex, consumeTransport, writeTransport } from "./transport";

/** Extension-lifetime platform services consumed by capture, history and Rust effects. */
export class HostServices implements vscode.Disposable {
  readonly configuration: HostConfiguration;
  readonly native: NativeHost;
  readonly credentials: HostCredentials;
  readonly diagnostics = new HostDiagnostics();
  readonly effects = new HostEffects(() => vscode.workspace.isTrusted);
  readonly presence = new PeerAwarenessHost(this.diagnostics);
  readonly capture: CaptureHost;
  readonly collection: CollectionHost;
  readonly sharing: SharingHost;
  readonly history: HistoryHost;
  readonly assembly: AssemblyHost;
  readonly coordination: CoordinationHost;
  readonly repository: RepositoryHost;
  readonly activity: ActivityDecorations;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeContext = this.changed.event;
  /** Byte adapters; the caller/Rust runtime owns protocol interpretation. */
  readonly transport = { bridgeDuplex, consumeTransport, writeTransport };
  private shutdownWork: Promise<void> | undefined;
  private readonly accountChanged: vscode.Disposable;

  constructor(context: vscode.ExtensionContext) {
    this.configuration = new HostConfiguration(context.extensionUri.fsPath);
    this.native = new NativeHost(() => this.configuration.nativeBinary());
    this.credentials = new HostCredentials(context.secrets, () => vscode.workspace.isTrusted,
      message => this.diagnostics.append(message));
    this.capture = new CaptureHost(context, this.configuration, this.diagnostics, this.native);
    this.collection = new CollectionHost(context, this.configuration, this.diagnostics, this.native);
    this.sharing = new SharingHost(context, this.configuration, this.credentials, this.diagnostics, this.native);
    this.history = new HistoryHost(this.native, this.effects, this.diagnostics);
    this.coordination = new CoordinationHost(context, this.configuration, this.native);
    this.repository = new RepositoryHost(context, this.configuration, this.credentials, () => this.coordination.contributor(), this.native);
    this.assembly = new AssemblyHost(this.configuration, this.history, this.effects, (folder, error) => {
      this.diagnostics.failure("Workspace " + folder, error);
      void this.diagnostics.notify("warning", "Idle cannot open " + folder + ": " + publicError(error).message);
    }, this.coordination, this.repository);
    this.activity = new ActivityDecorations(this.history, this.capture, this.assembly, this.diagnostics);
    const refreshCaptureAccount = () => { void this.capture.refreshAccount(async () => (await this.credentials.account())?.label); };
    refreshCaptureAccount();
    this.accountChanged = this.credentials.onDidChange(() => {
      this.capture.useAccount(undefined);
      refreshCaptureAccount();
      this.presence.disconnect();
      this.history.disconnect();
      this.assembly.reset();
      void this.sharing.reset(false).catch(error => this.diagnostics.failure("Account sharing reset", error));
      this.changed.fire();
    });
    this.registerPlatformEffects();
  }

  /** Cleanup runs in the native sharing service using the authorized account. */
  cleanupTunnels(): Promise<void> { return this.sharing.cleanup(); }

  private registerPlatformEffects(): void {
    this.effects.register("host.ready", () => ({ capabilities: this.effects.available(), configuration: this.configuration.snapshot(), mutation_prefix: randomUUID() }), false);
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
    this.accountChanged.dispose();
    this.presence.dispose();
    this.activity.dispose();
    this.assembly.dispose();
    this.changed.dispose();
    this.effects.dispose();
    try {
      const services = await Promise.allSettled([this.sharing.shutdown(), this.capture.shutdown(),
        this.collection.shutdown(), this.history.shutdown(), this.coordination.shutdown(), this.repository.shutdown()]);
      if (services.some(result => result.status === "rejected")) {
        throw new HostError("shutdown_failed", "Some host services did not close successfully.");
      }
    }
    finally {
      try { await this.native.shutdown(); }
      finally { this.credentials.dispose(); }
    }
  }

  dispose(): void {
    void this.shutdown().catch(error => this.diagnostics.failure("Host shutdown", error)).finally(() => this.diagnostics.dispose());
  }
}
