import * as path from "node:path";
import * as vscode from "vscode";

// Only the read-only subset of VS Code's built-in Git API is needed here.
interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: { name?: string }; onDidChange: vscode.Event<void> };
}
interface GitApi {
  state: "uninitialized" | "initialized";
  repositories: GitRepository[];
  onDidChangeState: vscode.Event<unknown>;
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
  enabled: boolean;
  onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

/** No Git remote inference or first-folder fallback; paths are checkout-relative. */
export function relativeFile(root: vscode.Uri, resource: vscode.Uri | undefined): string | null {
  if (!resource || resource.scheme !== root.scheme || resource.authority !== root.authority ||
      resource.query || resource.fragment) return null;
  const relative = path.relative(root.fsPath, resource.fsPath);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return relative.split(path.sep).join("/");
}

export class EditorObservation implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private gitSubscriptions: vscode.Disposable[] = [];
  private repositorySubscription: vscode.Disposable | undefined;
  private repository: GitRepository | undefined;
  private closed = false;
  private previousObservation = "";

  constructor(private readonly root: vscode.Uri, private readonly changed: () => void,
    failed: (error: unknown) => void) {
    this.previousObservation = JSON.stringify(this.current());
    this.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this.notify()));
    const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (extension) void Promise.resolve(extension.activate()).then(git => {
      if (this.closed) return;
      this.subscriptions.push(git.onDidChangeEnablement(() => this.attachGit(git)));
      this.attachGit(git);
    }).catch(error => { if (!this.closed) failed(error); });
  }

  current(): { file: string | null; branch: string | null } {
    return {
      file: relativeFile(this.root, vscode.window.activeTextEditor?.document.uri),
      branch: this.repository?.state.HEAD?.name || null,
    };
  }

  private attachGit(git: GitExtension): void {
    for (const subscription of this.gitSubscriptions) subscription.dispose();
    this.gitSubscriptions = [];
    if (!git.enabled) { this.selectRepository(undefined); return; }
    const api = git.getAPI(1);
    const update = () => this.selectRepository(api.state === "initialized"
      ? api.repositories.find(repository => repository.rootUri.toString() === this.root.toString()) : undefined);
    this.gitSubscriptions.push(api.onDidOpenRepository(update), api.onDidCloseRepository(update), api.onDidChangeState(update));
    update();
  }

  private selectRepository(repository: GitRepository | undefined): void {
    this.repositorySubscription?.dispose();
    this.repository = repository;
    this.repositorySubscription = repository?.state.onDidChange(() => this.notify());
    this.notify();
  }

  private notify(): void {
    const observation = JSON.stringify(this.current());
    if (observation === this.previousObservation) return;
    this.previousObservation = observation;
    this.changed();
  }

  dispose(): void {
    this.closed = true;
    this.repositorySubscription?.dispose();
    for (const subscription of [...this.subscriptions, ...this.gitSubscriptions]) subscription.dispose();
  }
}
