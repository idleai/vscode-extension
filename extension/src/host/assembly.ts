import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { HistoryHost, RepositoryBinding } from "../history";
import { FolderConfiguration, HostConfiguration } from "./configuration";
import { CoordinationHost } from "./coordination";
import { RepositoryHost } from "./repository";
import { HostCallContext, HostEffects } from "./effects";
import { HostError, record } from "./protocol";

interface LocalWorkspace {
  id: string;
  name: string;
  chain: string;
  revision: number;
  mode: "Standalone";
  repositories: { id: string; name: string; remote: null }[];
}

/** Local folder bindings. Coordination adapters can install their own effect routes. */
export class AssemblyHost implements vscode.Disposable {
  private directory: LocalWorkspace[] | undefined;
  private readonly folders = new Map<string, vscode.Uri>();
  private readonly bindings: vscode.Disposable[] = [];
  private readonly installed: { dispose(): void }[];

  constructor(private readonly configuration: HostConfiguration, private readonly history: HistoryHost, effects: HostEffects,
    private readonly report: (folder: string, error: unknown) => void, private readonly coordination?: CoordinationHost,
    private readonly repository?: RepositoryHost) {
    this.installed = [
      effects.register("app.workspace", params => this.workspace(params)),
      effects.register("app.history", (params, context) => {
        this.list();
        return history.query(params, context.signal);
      }),
      effects.register("app.projection", (params, context) => this.projection(params, context)),
    ];
    if (repository) this.installed.push(effects.register("app.repository", (params, context) => {
      const { config, binding } = this.selected(params);
      return repository.read(config, binding, params, context);
    }));
    if (coordination) this.installed.push(
      effects.register("app.coordination", (params, context) => this.coordinate(params, context)),
      effects.register("app.configurationState", (params, context) => this.coordinate(params, context, true)),
      effects.register("app.subscription", async (params, context) => {
        if (!record(params) || !record(params.operation) || !record(params.operation.action)) throw new HostError("invalid_request", "Invalid subscription operation.");
        const action = params.operation.action;
        if (record(action.Leave)) return { Ok: "Left" };
        if (record(action.Wait) && Number.isInteger(action.Wait.delay_ms) && Number(action.Wait.delay_ms) >= 0 && Number(action.Wait.delay_ms) <= 30_000) {
          await delay(Number(action.Wait.delay_ms), undefined, { signal: context.signal });
          return { Ok: "Elapsed" };
        }
        throw new HostError("unavailable", "This subscription is unavailable.");
      }),
    );
  }

  private list(): LocalWorkspace[] {
    this.configuration.assertTrusted();
    if (this.directory) return this.directory;
    const workspaces: LocalWorkspace[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const config = this.configuration.forResource(folder.uri);
        // These are host-local aliases, not shared repository or runtime identities.
        const { repository_id: repository, chain, workspace_id: workspace } = localBinding(config);
        this.bindings.push(this.history.connect({ root: folder.uri, chainDirectory: config.chainDirectory,
          repository: { workspace_id: workspace, repository_id: repository, chain } }));
        this.folders.set(workspace, folder.uri);
        workspaces.push({ id: workspace, name: folder.name, chain, revision: 1, mode: "Standalone",
          repositories: [{ id: repository, name: folder.name, remote: null }] });
      } catch (error) { this.report(folder.name, error); }
    }
    this.directory = workspaces;
    return workspaces;
  }

  /** Notifications carry the same explicit logical binding used by native reads. */
  bindingFor(resource: vscode.Uri): RepositoryBinding {
    return localBinding(this.configuration.forResource(resource));
  }

  /** Native editor reads must also work before a workspace webview is opened. */
  ensureBindingFor(resource: vscode.Uri): RepositoryBinding {
    this.list();
    return this.bindingFor(resource);
  }

  private coordinate(params: unknown, context: HostCallContext, state = false): Promise<unknown> {
    const { config, binding } = this.selected(params);
    return state ? this.coordination!.configurationState(binding, params, context)
      : this.coordination!.read(config, binding, params, context);
  }

  private async projection(params: unknown, context: HostCallContext): Promise<unknown> {
    if (!this.repository) return this.history.projection(params, context.signal);
    const { config, binding } = this.selected(params);
    let inputs: unknown[] | undefined;
    const refresh = record(params) && record(params.operation) && params.operation.refresh_sources === true;
    try { inputs = (await this.repository.snapshot(config, binding, context.signal, refresh ? 'refresh' : 'projection')).projections; }
    catch (error) {
      if (context.signal.aborted || (error instanceof HostError && error.code === 'cancelled')) throw error;
      this.report(config.folder.name, error);
    }
    return this.history.projection(params, context.signal, inputs);
  }

  private selected(params: unknown): { config: FolderConfiguration; binding: RepositoryBinding } {
    this.list();
    if (!record(params) || !record(params.binding) || typeof params.binding.workspace_id !== "string") throw new HostError("invalid_request", "Coordination requires a repository binding.");
    const folder = this.folders.get(params.binding.workspace_id);
    if (folder) {
      const config = this.configuration.forResource(folder);
      const binding = localBinding(config);
      if (binding.workspace_id === params.binding.workspace_id && binding.repository_id === params.binding.repository_id && binding.chain === params.binding.chain) {
        return { config, binding };
      }
    }
    throw new HostError("unavailable", "This coordination binding is no longer available.");
  }

  private workspace(params: unknown): unknown {
    if (!record(params)) throw new HostError("invalid_request", "Expected a workspace operation.");
    const workspaces = this.list();
    if (params.operation === "List") return { Ok: { Directory: workspaces } };
    if (!record(params.operation) || Object.keys(params.operation).length !== 1) throw new HostError("invalid_request", "Invalid workspace operation.");
    const snapshot = record(params.operation.Snapshot) ? params.operation.Snapshot : undefined;
    const presence = record(params.operation.Presence) ? params.operation.Presence : undefined;
    const request = snapshot ?? presence;
    const workspace = workspaces.find(workspace => workspace.id === request?.workspace_id);
    if (!workspace || request?.mode !== "Standalone") throw new HostError("unavailable", "This workspace connection is unavailable.");
    if (snapshot) return { Ok: { Snapshot: { workspace, members: [], host_ids: [], provider_ids: [] } } };
    return { Ok: { Presence: { workspace_id: workspace.id, as_of_ms: Date.now(), entries: [] } } };
  }

  reset(): void {
    this.directory = undefined;
    this.folders.clear();
    this.coordination?.reset();
    this.repository?.reset();
    for (const binding of this.bindings.splice(0)) binding.dispose();
  }

  dispose(): void {
    this.reset();
    for (const installed of this.installed) installed.dispose();
  }
}

function alias(kind: string, value: string): string {
  return `local-${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

function localBinding(config: FolderConfiguration): RepositoryBinding {
  const repository = alias("repository", config.folder.uri.toString());
  const chain = alias("chain", config.chainDirectory);
  return { workspace_id: alias("workspace", `${repository}\0${chain}`), repository_id: repository, chain };
}
