import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as vscode from "vscode";
import { HostEffects } from "./effects";
import { HostError, publicError, record } from "./protocol";
import { NativeTree, TreeSnapshot } from "./nativeTrees";
import { WorkspaceViewProvider } from "./webviews";
import { SIDEBAR_VIEWS } from "./viewSelection";

interface RustSidebar { update(input: string): string; free(): void }
interface Call { id: string; method: string; params: unknown }
interface Update { trees: TreeSnapshot[]; calls: Call[]; selection: unknown | null; detail: unknown | null }

/** A single headless Rust application serves every native list, including hidden ones. */
export class NativeSidebar implements vscode.Disposable {
  private readonly trees = new Map<string, NativeTree>();
  private readonly session = randomUUID();
  private readonly pending = new Map<string, AbortController>();
  private readonly subscription: vscode.Disposable;
  private runtime: RustSidebar | undefined;
  private ready: Promise<void> | undefined;
  private generation = 0;
  private closed = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly effects: HostEffects,
    private readonly webviews: WorkspaceViewProvider,
    private readonly failure: (error: unknown) => void,
    private readonly load: () => RustSidebar = () => {
      const module = require(join(context.extensionUri.fsPath, "dist/native/idle_vscode_webview.js")) as { NativeSidebar: new () => RustSidebar };
      return new module.NativeSidebar();
    },
  ) {
    for (const id of Object.keys(SIDEBAR_VIEWS).filter(id => id !== "idle.activity")) {
      this.trees.set(id, new NativeTree(id, () => this.start()));
    }
    this.subscription = webviews.onDidBroadcast(({ event, params }) => {
      if (!this.runtime || this.closed) return;
      try {
        if (event === "host.configurationChanged") this.ready = this.handshake();
        else if (event === "host.workspaceSelected") this.apply("Workspace", params);
        else if (event === "history.changed") this.apply("HistoryChanged", params);
      } catch (error) { this.report(error); }
    });
  }

  private start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.ready ??= this.handshake();
  }

  private async handshake(): Promise<void> {
    const generation = ++this.generation;
    this.abort();
    try {
      this.runtime ??= this.load();
      this.apply("Reset");
      const controller = new AbortController();
      this.pending.set("ready", controller);
      const value = await this.effects.execute("host.ready", {}, { signal: controller.signal, session: this.session, viewKind: "sidebar" });
      if (this.closed || generation !== this.generation) return;
      this.pending.delete("ready");
      this.apply("Ready", value);
      const selected = this.webviews.ensureWorkspace();
      if (selected) this.apply("Workspace", selected);
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.report(error);
    }
  }

  async activate(value: unknown): Promise<void> {
    const id = typeof value === "string" ? value : record(value) ? value.id : undefined;
    if (typeof id !== "string" || id.length > 32768) throw new HostError("invalid_request", "Invalid sidebar row.");
    await this.start();
    try { this.apply("Activate", id); }
    catch (error) {
      if (typeof error === "string") throw new HostError("stale_selection", "This row changed. Refresh the view and select it again.");
      throw error;
    }
  }

  async refresh(section: string): Promise<void> {
    if (!this.runtime) this.ready = undefined;
    await this.start();
    this.apply("Refresh", section);
  }

  filter(id: string): Promise<void> { return this.trees.get(id)?.filter() ?? Promise.resolve(); }
  clearFilter(id: string): void { this.trees.get(id)?.setFilter(""); }

  private apply(type: string, value?: unknown): void {
    if (this.closed || !this.runtime) return;
    const update = JSON.parse(this.runtime.update(JSON.stringify({ type, value }))) as Update;
    if (update.selection) {
      try { void Promise.resolve(this.webviews.selectWorkspace(update.selection)).catch(error => this.report(error)); }
      catch (error) { this.ready = this.handshake(); throw error; }
    }
    for (const tree of update.trees) this.trees.get(tree.id)?.update(tree.rows);
    if (update.detail) this.webviews.openTarget(update.detail);
    for (const call of update.calls) void this.execute(call, this.generation);
  }

  private async execute(call: Call, generation: number): Promise<void> {
    const controller = new AbortController();
    this.pending.set(call.id, controller);
    const timeout = setTimeout(() => {
      controller.abort();
      if (!this.closed && generation === this.generation) {
        try { this.apply("Reply", { id: call.id, result: { Err: { code: "host_timeout", message: "The host did not respond. Refresh to retry." } } }); }
        catch (error) { this.report(error); }
      }
    }, 60_000);
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    try {
      let result: unknown;
      try {
        result = { Ok: (await this.effects.execute(call.method, call.params,
          { signal: controller.signal, session: this.session, viewKind: "sidebar" })) ?? null };
      } catch (error) { result = { Err: publicError(error) }; }
      if (!this.closed && !controller.signal.aborted && generation === this.generation) this.apply("Reply", { id: call.id, result });
    } catch (error) { if (!this.closed && generation === this.generation) this.report(error); }
    finally { clearTimeout(timeout); if (this.pending.get(call.id) === controller) this.pending.delete(call.id); }
  }

  private abort(): void { for (const controller of this.pending.values()) controller.abort(); this.pending.clear(); }

  private report(error: unknown): void {
    this.failure(error);
    for (const tree of this.trees.values()) tree.fail(publicError(error).message);
  }

  dispose(): void {
    this.closed = true;
    this.abort();
    this.subscription.dispose();
    for (const tree of this.trees.values()) tree.dispose();
    this.runtime?.free();
    this.runtime = undefined;
  }
}
