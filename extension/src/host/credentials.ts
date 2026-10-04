import * as vscode from "vscode";
import { HostError } from "./protocol";

export const GITHUB_SCOPES = ["read:user", "read:org"] as const;
export const GITHUB_REPOSITORY_SCOPES = ["repo", "read:user", "read:org"] as const;
export interface Account { readonly id: string; readonly label: string }

/** VS Code stores credentials. Tokens never cross the webview boundary. */
export class HostCredentials implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private disposed = false;
  private generation = 0;

  constructor(private readonly secrets: vscode.SecretStorage, private readonly trusted: () => boolean) {
    this.subscription = vscode.authentication.onDidChangeSessions(event => {
      if (event.provider.id === "github") { this.generation++; this.changed.fire(); }
    });
  }

  async account(interactive = false): Promise<Account | undefined> {
    const session = await this.session(interactive);
    return session && { id: session.account.id, label: session.account.label };
  }

  /** Repository access is requested only by its explicit connect action. */
  async repositorySession(interactive = false): Promise<vscode.AuthenticationSession | undefined> {
    this.assertTrusted();
    const generation = this.generation;
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession("github", GITHUB_REPOSITORY_SCOPES,
        interactive ? { createIfNone: true } : { silent: true });
      if (!session && !interactive) session = await this.session(false);
    } catch {
      throw new HostError("authentication_failed", "GitHub repository authentication was cancelled or is unavailable.");
    }
    this.assertTrusted();
    if (!interactive && generation !== this.generation) throw new HostError("account_changed", "The GitHub account changed during the repository read.");
    return session;
  }

  /** Every use rechecks trust and identity, including SDK refresh callbacks. */
  tokenProvider(accountId: string): () => Promise<string> {
    return async () => {
      const session = await this.session(false);
      if (!session || session.account.id !== accountId) {
        throw new HostError("account_changed", "The authorized GitHub account changed. Sign in again.");
      }
      return session.accessToken;
    };
  }

  get(scope: string, key: string): Thenable<string | undefined> {
    this.assertTrusted();
    return this.secrets.get(this.key(scope, key));
  }

  store(scope: string, key: string, value: string): Thenable<void> {
    this.assertTrusted();
    return this.secrets.store(this.key(scope, key), value);
  }

  delete(scope: string, key: string): Thenable<void> {
    this.assertTrusted();
    return this.secrets.delete(this.key(scope, key));
  }

  private async session(interactive: boolean): Promise<vscode.AuthenticationSession | undefined> {
    this.assertTrusted();
    const generation = this.generation;
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession("github", GITHUB_SCOPES,
        interactive ? { createIfNone: true } : { silent: true });
    } catch {
      throw new HostError("authentication_failed", "GitHub authentication was cancelled or is unavailable.");
    }
    this.assertTrusted();
    // Interactive sign-in itself may emit an account event. Its result is shown
    // as metadata only; SDK token callbacks always use the generation check.
    if (!interactive && generation !== this.generation) throw new HostError("account_changed", "The authorized GitHub account changed. Sign in again.");
    return session;
  }

  private assertTrusted(): void {
    if (this.disposed) throw new HostError("host_closed", "The credential adapter is closed.");
    if (!this.trusted()) throw new HostError("workspace_untrusted", "Trust this workspace before accessing credentials.");
  }

  private key(scope: string, key: string): string {
    if (!scope || !key || scope.length > 512 || key.length > 512) throw new HostError("invalid_request", "Invalid credential identifier.");
    return `idle:${encodeURIComponent(scope)}:${encodeURIComponent(key)}`;
  }

  dispose(): void { this.disposed = true; this.subscription.dispose(); this.changed.dispose(); }
}
