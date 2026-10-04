import * as path from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { SavedSharing, SharingStatus, DiscoveryStatus } from "./types";
import { TunnelJournal } from "../host/tunnelJournal";
import { describeScope, type ScopeChoice } from "./scope";
import { HostConfiguration } from "../host/configuration";
import { HostCredentials, type Account } from "../host/credentials";
import { HostDiagnostics } from "../host/diagnostics";
import { HostError } from "../host/protocol";
import { createManager, NativeSharing } from "./runtime";
import { MultiplayerStatusOutput } from "./statusOutput";
import { sharingDetails, sharingLabel } from "./statusBar";

interface Entry {
  folder: vscode.WorkspaceFolder;
  key: string;
  account: Account;
  manager: NativeSharing;
  credentialsActive: boolean;
  journal: TunnelJournal;
  updates: Promise<void>;
  active: boolean;
  directory?: boolean;
  discovery?: DiscoveryStatus;
  output?: MultiplayerStatusOutput;
}
interface DirectorySettings { repository: string; account: string }
const ENABLED = "idle.sharing.enabled.";
const ACCOUNT = "idle.sharing.account.";
const DIRECTORY = "idle.sharing.directory.";

/** A saved approval belongs to one physical folder and chain, independent of view lifetimes. */
export function sharingKey(folder: vscode.Uri, chain: string): string {
  return createHash("sha256").update(folder.toString()).update("\0").update(chain).digest("hex");
}

/** Owns standalone history sharing on the file host; views never receive credentials. */
export class SharingHost implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly retiring = new Set<Entry>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 11);
  private readonly subscriptions: vscode.Disposable[] = [];
  private generation = 0;
  private busy = false;
  private closed = false;
  private transition = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext,
    private readonly configuration: HostConfiguration,
    private readonly credentials: HostCredentials,
    private readonly diagnostics: HostDiagnostics,
    private readonly factory: typeof createManager = createManager) {
    this.status.name = "Idle history sharing";
    this.status.command = "idle.sharing.status";
    this.registerCommands();
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        const folders = new Set((vscode.workspace.workspaceFolders ?? []).filter(folder =>
          event.affectsConfiguration("idle.chainDirectory", folder.uri))
          .map(folder => folder.uri.toString()));
        if (folders.size) {
          void this.reset(true, folders).catch(error => this.diagnostics.failure("Restarting sharing", error));
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        const present = new Set(vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()));
        const removed = new Set([...this.entries.values()].filter(entry => !present.has(entry.folder.uri.toString()))
          .map(entry => entry.folder.uri.toString()));
        void this.reset(true, removed).catch(error => this.diagnostics.failure("Refreshing shared folders", error));
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.reset(true).catch(error => this.diagnostics.failure("Resuming sharing", error));
      }),
    );
    this.ready = this.resumeEnabled();
    void this.ready.catch(error => this.diagnostics.failure("Restoring sharing", error));
  }

  private registerCommands(): void {
    const command = (name: string, action: (entry: Entry, current: () => void) => Promise<unknown>) => {
      this.subscriptions.push(vscode.commands.registerCommand(`idle.sharing.${name}`, () =>
        this.diagnostics.command("History sharing", () => this.run(action))));
    };
    command("request", async (entry, current) => {
      const request = await entry.manager.joinRequest(); current();
      await vscode.env.clipboard.writeText(request);
      await this.diagnostics.notify("info", "Join request copied. Give it to the person hosting the shared history.");
    });
    command("host", async (entry, current) => {
      const text = await vscode.window.showInputBox({ title: "Host shared history", prompt: "Paste the joining device's request", ignoreFocusOut: true });
      current(); if (!text) return;
      const request = await entry.manager.inspectRequest(text); current();
      const scope = await this.chooseScope(entry); current(); if (scope === undefined) return;
      const approval = await vscode.window.showWarningMessage(`Approve device ${request.device.fingerprint} to exchange history with ${entry.folder.name}?`, { modal: true }, "Approve device");
      current(); if (approval !== "Approve device") return;
      const invitation = await entry.manager.hostHistory(text, scope); current();
      await vscode.env.clipboard.writeText(invitation);
      await this.diagnostics.notify("info", "Private invitation copied. Give it to the approved device. It expires in at most one hour.");
      current(); await this.startDirectory(entry);
    });
    command("join", async (entry, current) => {
      const text = await vscode.window.showInputBox({ title: "Join shared history", prompt: "Paste the host's private invitation", password: true, ignoreFocusOut: true });
      current(); if (!text) return;
      const invitation = await entry.manager.inspectInvitation(text); current();
      const scope = await this.chooseScope(entry); current(); if (scope === undefined) return;
      const approval = await vscode.window.showWarningMessage(`Join space ${invitation.space} with host device ${invitation.host.fingerprint}?`, { modal: true }, "Join space");
      current(); if (approval !== "Join space") return;
      await entry.manager.joinHistory(text, scope); current(); await this.startDirectory(entry);
    });
    command("scope", async (entry, current) => {
      const scope = await this.chooseScope(entry, true); current();
      if (scope === undefined || scope === "keep") return;
      await entry.manager.changeScope(scope); current();
      await this.diagnostics.notify("info", describeScope(entry.manager.status().scope));
    });
    command("remove", async (entry, current) => {
      const devices = await entry.manager.devices(); current();
      const choice = await vscode.window.showQuickPick(devices.map(device => ({ label: device.fingerprint, device })), { title: "Remove an approved device" });
      current(); if (choice) await entry.manager.revoke(choice.device.fingerprint);
    });
    command("resume", async (entry, current) => {
      entry.directory = undefined;
      await this.restore(entry); current();
      await entry.manager.reconnect(); current();
    });
    command("discovery", (entry, current) => this.configureDirectory(entry, current));
    this.subscriptions.push(
      vscode.commands.registerCommand("idle.sharing.status", () => {
        const values = [...this.entries.values()].map(entry => ({ folder: entry.folder.name,
          ...entry.manager.status(), discovery: entry.discovery }));
        for (const entry of this.entries.values()) {
          entry.output ??= new MultiplayerStatusOutput(line => this.diagnostics.append(`${entry.folder.name}: ${line}`));
          entry.output.show({ ...entry.manager.status(), discovery: entry.discovery });
        }
        this.diagnostics.append(JSON.stringify(values, null, 2)); this.diagnostics.show();
        return values;
      }),
      vscode.commands.registerCommand("idle.sharing.stop", () => this.diagnostics.command("Stopping sharing", () => this.stop())),
    );
  }

  private async run(action: (entry: Entry, current: () => void) => Promise<unknown>): Promise<unknown> {
    if (this.busy) throw new HostError("busy", "Another sharing command is running.");
    this.busy = true;
    const generation = this.generation;
    try {
      await this.ready;
      await this.transition; this.assertCurrent(generation);
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === "file");
      const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
        folders.map(value => ({ label: value.name, description: value.uri.fsPath, folder: value })),
        { title: "Choose the workspace history" }))?.folder;
      this.assertCurrent(generation);
      if (!folder) return;
      const entry = await this.entry(folder, generation);
      return await action(entry, () => { this.assertCurrent(generation); if (!entry.active) throw new HostError("cancelled", "Sharing was stopped."); });
    } finally { this.busy = false; }
  }

  private assertCurrent(generation: number): void {
    this.configuration.assertTrusted();
    if (this.closed || generation !== this.generation) throw new HostError("cancelled", "Sharing context changed.");
  }

  private async entry(folder: vscode.WorkspaceFolder, generation: number): Promise<Entry> {
    this.assertCurrent(generation);
    const config = this.configuration.forResource(folder.uri);
    const key = sharingKey(folder.uri, config.chainDirectory);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const account = await this.credentials.account(); this.assertCurrent(generation);
    if (!account) throw new HostError("authentication_required", "Run Idle: Sign In to GitHub first.");
    const raced = this.entries.get(key);
    if (raced) return raced;
    const entry = this.createEntry(folder, key, account);
    this.entries.set(key, entry);
    try { await this.migrate(entry); this.assertCurrent(generation); }
    catch (error) {
      entry.active = false;
      if (this.entries.get(key) === entry) this.entries.delete(key);
      try { await entry.manager.suspend(); } finally { entry.credentialsActive = false; await entry.journal.release(); }
      throw error;
    }
    return entry;
  }

  private createEntry(folder: vscode.WorkspaceFolder, key: string, account: Account): Entry {
    const config = this.configuration.forResource(folder.uri);
    const journal = new TunnelJournal(this.context.globalState, account.id);
    const directory = path.join(this.context.globalStorageUri.fsPath, 'history-sharing',
      createHash('sha256').update(account.id).digest('hex'), key);
    const entry: Entry = { folder, key, account, active: true, credentialsActive: true, journal, updates: Promise.resolve(), manager: this.factory({
      key, account: account.id, name: folder.name, cwd: folder.uri.fsPath, chain: config.chainDirectory,
      stateDirectory: directory,
      deviceDirectory: path.join(this.context.globalStorageUri.fsPath, 'history-sharing-device'),
      credential: async purpose => {
        this.configuration.assertTrusted();
        if (!entry.credentialsActive) throw new HostError('cancelled', 'Sharing credentials retired.');
        if (purpose === 'management') return this.credentials.tokenProvider(account.id)();
        const settings = this.context.workspaceState.get<DirectorySettings>(DIRECTORY + key);
        if (!settings) return undefined;
        const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
        this.configuration.assertTrusted();
        if (!entry.credentialsActive || session?.account.id !== settings.account || settings.account !== account.id) {
          throw new HostError('account_changed', 'Repository discovery account is unavailable.');
        }
        return session.accessToken;
      },
      saveEnabled: enabled => this.enqueueUpdate(entry, async () => {
        if (enabled) await this.context.workspaceState.update(ACCOUNT + key, account.id);
        if (entry.active) await this.context.workspaceState.update(ENABLED + key, enabled || undefined);
      }),
      changed: (value, durable) => { if (entry.active) this.update(entry, value, durable); },
    }, this.context.extensionUri.fsPath) };
    return entry;
  }

  private enqueueUpdate(entry: Entry, action: () => Promise<void>): Promise<void> {
    const next = entry.updates.then(async () => { if (entry.active) await action(); });
    entry.updates = next.catch(() => {});
    return next;
  }

  private update(entry: Entry, value: SharingStatus, durable: boolean): void {
    entry.discovery = value.discovery;
    const enabled = [...this.entries.values()].filter(entry => entry.manager.status().enabled);
    entry.output?.update({ ...value, discovery: entry.discovery });
    this.status.text = `$(broadcast) ${enabled.length === 1 ? sharingLabel(enabled[0].manager.status()) : `Sharing (${enabled.length})`}`;
    this.status.tooltip = enabled.map(entry => `${entry.folder.name}\n${sharingDetails(entry.manager.status())}`).join("\n\n");
    if (enabled.length) this.status.show(); else this.status.hide();
    if (durable) this.changed.fire(entry.folder.uri);
  }

  private async chooseScope(entry: Entry, changing = false): Promise<ScopeChoice | undefined> {
    const scope = await entry.manager.sharingScope();
    const choices: { label: string; detail: string; value: ScopeChoice }[] = [
      { label: "Share records added from now on", detail: "Previously received copies remain on other devices.", value: false },
      { label: "Include existing history", detail: "Share retained operations and their referenced content.", value: true },
    ];
    if (scope?.active && !changing) choices.unshift({ label: "Keep current sharing scope", detail: describeScope(scope), value: "keep" });
    return (await vscode.window.showQuickPick(choices, { title: `Outgoing history from ${entry.folder.name}` }))?.value;
  }

  private async migrate(entry: Entry): Promise<void> {
    const stored = await this.credentials.get(entry.key, 'sharing');
    if (!entry.active || !stored) return;
    if (stored.length > 512 * 1024) throw new HostError('sharing_unavailable', 'Saved sharing session is invalid.');
    let envelope: { account: string; session: SavedSharing };
    try { envelope = JSON.parse(stored); } catch { throw new HostError('sharing_unavailable', 'Saved sharing session is invalid.'); }
    if (!envelope || envelope.account !== entry.account.id) throw new HostError('account_changed', 'Sign in with the account that enabled this sharing session.');
    const marker = envelope.session?.host?.marker;
    if (marker) await entry.journal.remember(marker);
    if (!entry.active) return;
    await entry.manager.importSaved(envelope.session);
    if (marker) { await entry.manager.importCleanup([marker]); await entry.journal.forget(marker); }
    if (!entry.active) return;
    await this.enqueueUpdate(entry, async () => {
      await this.context.workspaceState.update(ACCOUNT + entry.key, entry.account.id);
      if (entry.active) await this.credentials.delete(entry.key, 'sharing');
    });
  }

  private async restore(entry: Entry): Promise<void> {
    const owner = this.context.workspaceState.get<string>(ACCOUNT + entry.key);
    if (owner !== entry.account.id) throw new HostError('account_changed', 'Sign in with the account that enabled this sharing session.');
    await entry.manager.resume();
    if (entry.active) await this.startDirectory(entry);
  }

  private async resumeEnabled(): Promise<void> {
    if (!vscode.workspace.isTrusted || this.closed) return;
    const generation = this.generation;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        this.assertCurrent(generation);
        const config = this.configuration.forResource(folder.uri);
        const key = sharingKey(folder.uri, config.chainDirectory);
        if (!this.context.workspaceState.get<boolean>(ENABLED + key)) continue;
        await this.restore(await this.entry(folder, generation));
      } catch (error) {
        if (generation !== this.generation || this.closed) return;
        this.diagnostics.failure(`Restoring sharing for ${folder.name}`, error);
      }
    }
  }

  private async startDirectory(entry: Entry): Promise<void> {
    if (!entry.active || !entry.manager.status().enabled || entry.directory) return;
    const settings = this.context.workspaceState.get<DirectorySettings>(DIRECTORY + entry.key);
    if (!settings) return;
    if (settings.account !== entry.account.id) throw new HostError('account_changed', 'Repository discovery account is unavailable.');
    entry.directory = true;
    await entry.manager.configureDirectory(settings.repository);
  }

  private async configureDirectory(entry: Entry, current: () => void): Promise<void> {
    if (!entry.manager.status().enabled) throw new HostError("sharing_unavailable", "Host or join before enabling discovery.");
    const choice = await vscode.window.showQuickPick([
      { label: "Enable repository discovery", value: true }, { label: "Disable repository discovery", value: false },
    ], { title: "Optional GitHub peer discovery" });
    current(); if (!choice) return;
    let settings: DirectorySettings | undefined;
    if (choice.value) {
      const text = await vscode.window.showInputBox({ title: "Discovery repository", prompt: "owner/repository (collaborator access required)" });
      current(); if (!text) return;
      const repository = text.trim();
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.length > 256) {
        throw new HostError('invalid_request', 'Use an owner/repository name.');
      }
      const approval = await vscode.window.showWarningMessage(`Publish this space's public device identity and relay endpoint in ${repository}? Discovery requests GitHub repo access; invitations still control enrollment.`, { modal: true }, "Enable discovery");
      current(); if (approval !== "Enable discovery") return;
      const session = await vscode.authentication.getSession("github", ["repo"], { createIfNone: true }); current();
      if (session.account.id !== entry.account.id) throw new HostError('account_changed', 'Select the account that enabled sharing.');
      settings = { repository, account: session.account.id };
    }
    if (entry.directory) await entry.manager.configureDirectory(); current(); entry.directory = undefined; entry.discovery = undefined;
    await this.context.workspaceState.update(DIRECTORY + entry.key, settings); current();
    await this.startDirectory(entry);
  }

  /** Retire callbacks synchronously; pending commands cannot enable a replacement context. */
  reset(resume: boolean, folders?: ReadonlySet<string>): Promise<void> {
    this.generation++;
    const entries = [...new Set([...this.entries.values()].filter(entry => !folders || folders.has(entry.folder.uri.toString()))
      .concat([...this.retiring]))];
    entries.forEach(entry => this.entries.delete(entry.key));
    const remaining = this.entries.values().next().value as Entry | undefined;
    if (remaining) this.update(remaining, remaining.manager.status(), false); else this.status.hide();
    const closing = entries.map(entry => {
      entry.active = false; this.retiring.add(entry);
      entry.output?.dispose();
      return Promise.all([entry.manager.suspend(), entry.updates]).finally(async () => { entry.credentialsActive = false; await entry.journal.release(); })
        .then(() => { this.retiring.delete(entry); });
    });
    const settled = Promise.allSettled(closing);
    const generation = this.generation;
    const transition = this.transition.then(async () => {
      const results = await settled;
      if (results.some(result => result.status === "rejected")) throw new HostError("sharing_cleanup", "Sharing closed; tunnel cleanup needs attention.");
      if (resume && generation === this.generation && !this.closed) await this.resumeEnabled();
    });
    this.transition = transition.catch(() => {});
    return transition;
  }

  /** Explicit Stop removes saved approvals for automatic resumption in every open folder. */
  stop(): Promise<void> {
    this.generation++;
    const entries = [...new Set([...this.entries.values(), ...this.retiring])];
    const keys = new Set(entries.map(entry => entry.key));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      const config = this.configuration.forResource(folder.uri);
      const key = sharingKey(folder.uri, config.chainDirectory);
      keys.add(key);
      const account = this.context.workspaceState.get<string>(ACCOUNT + key);
      if (account && !entries.some(entry => entry.key === key)) {
        entries.push(this.createEntry(folder, key, { id: account, label: account }));
      }
    }
    this.entries.clear(); this.status.hide();
    const closing = entries.map(async entry => {
      entry.active = false; this.retiring.add(entry);
      entry.output?.dispose();
      const results = await Promise.allSettled([entry.manager.stop(), entry.updates]);
      entry.credentialsActive = false; await entry.journal.release();
      await this.context.workspaceState.update(ENABLED + entry.key, undefined);
      await this.credentials.delete(entry.key, "sharing");
      if (results.some(result => result.status === "rejected")) throw new HostError("sharing_cleanup", "Sharing stopped; use Idle: Clean Up Dev Tunnels to retry cleanup.");
      this.retiring.delete(entry);
    });
    const settled = Promise.allSettled(closing);
    const transition = this.transition.then(async () => {
      const results = await settled;
      for (const key of keys) {
        await this.context.workspaceState.update(ENABLED + key, undefined);
        await this.credentials.delete(key, "sharing");
      }
      if (results.some(result => result.status === "rejected")) throw new HostError("sharing_cleanup", "Sharing stopped; saved state or tunnel cleanup needs attention.");
    });
    this.transition = transition.catch(() => {});
    return transition;
  }

  /** Native journals retain unsuccessful deletions; old markers move only after acknowledgement. */
  async cleanup(): Promise<void> {
    await this.run(async entry => {
      const markers = entry.journal.inactiveMarkers();
      for (const marker of markers) {
        await entry.journal.remember(marker);
        try {
          await entry.manager.importCleanup([marker]);
          await entry.journal.forget(marker);
        } finally { await entry.journal.releaseMarker(marker); }
      }
      for (const current of this.entries.values()) await current.manager.cleanup();
      await this.diagnostics.notify('info', 'Retried pending Dev Tunnel cleanup.');
    });
  }

  async shutdown(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.subscriptions.forEach(value => value.dispose());
      this.changed.dispose(); this.status.dispose();
    }
    await this.reset(false);
    await this.ready;
  }

  dispose(): void { void this.shutdown().catch(error => this.diagnostics.failure("Closing sharing", error)); }
}
