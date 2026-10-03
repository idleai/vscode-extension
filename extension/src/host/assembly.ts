import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { HistoryHost, RepositoryBinding } from "../history";
import { FolderConfiguration, HostConfiguration } from "./configuration";
import { HostEffects } from "./effects";
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
  private readonly bindings: vscode.Disposable[] = [];
  private readonly installed: { dispose(): void }[];

  constructor(private readonly configuration: HostConfiguration, private readonly history: HistoryHost, effects: HostEffects,
    private readonly report: (folder: string, error: unknown) => void) {
    this.installed = [
      effects.register("app.workspace", params => this.workspace(params)),
      effects.register("app.history", (params, context) => history.query(params, context.signal)),
    ];
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
