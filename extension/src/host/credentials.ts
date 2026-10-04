import * as vscode from "vscode";
import { prepareGitHubSignIn } from "./githubSignIn";
import { HostError } from "./protocol";

export const GITHUB_SCOPES = ["read:user", "read:org"] as const;
export const GITHUB_REPOSITORY_SCOPES = ["repo", "read:user", "read:org"] as const;
// VS Code's GitHub integration uses this scope set. Its provider matches exact
// scope lists, so an existing session must be looked up with the same list.
const VSCODE_GITHUB_SCOPES = ["repo", "workflow", "user:email", "read:user"] as const;
export interface Account { readonly id: string; readonly label: string }

/** VS Code stores credentials. Tokens never cross the webview boundary. */
export class HostCredentials implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private disposed = false;
  private generation = 0;
  private readonly signingIn = new Map<string, Promise<vscode.AuthenticationSession>>();

  constructor(private readonly secrets: vscode.SecretStorage, private readonly trusted: () => boolean,
    private readonly report: (message: string) => void = () => {}) {
    this.subscription = vscode.authentication.onDidChangeSessions(event => {
      if (event.provider.id === "github") {
        this.report("GitHub sessions changed; clearing the previous account context.");
        this.generation++;
        this.changed.fire();
      }
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
    let signedIn = false;
    try {
      session = await vscode.authentication.getSession("github", GITHUB_REPOSITORY_SCOPES, { silent: true });
      session ??= await vscode.authentication.getSession("github", VSCODE_GITHUB_SCOPES, { silent: true });
      if (session && interactive) this.report("GitHub repository access: reusing the existing VS Code session.");
      if (!session && interactive) {
        session = await this.signIn(GITHUB_REPOSITORY_SCOPES);
        signedIn = true;
      }
      if (!session) session = await this.session(false);
    } catch (error) {
      throw authenticationFailure(error);
    }
    this.assertTrusted();
    if (!signedIn && generation !== this.generation) throw new HostError("account_changed", "The GitHub account changed during the repository read.");
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
    let signedIn = false;
    try {
      session = await vscode.authentication.getSession("github", GITHUB_SCOPES, { silent: true });
      if (!session && interactive) {
        session = await this.signIn(GITHUB_SCOPES);
        signedIn = true;
      }
    } catch (error) {
      throw authenticationFailure(error);
    }
    this.assertTrusted();
    // Interactive sign-in itself may emit an account event. Its result is shown
    // as metadata only; SDK token callbacks always use the generation check.
    if (!signedIn && generation !== this.generation) throw new HostError("account_changed", "The authorized GitHub account changed. Sign in again.");
    return session;
  }

  private signIn(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    const key = scopes.join(" ");
    const pending = this.signingIn.get(key);
    if (pending) return pending;
    const work = this.createSession(scopes);
    this.signingIn.set(key, work);
    const finished = () => { if (this.signingIn.get(key) === work) this.signingIn.delete(key); };
    void work.then(finished, finished);
    return work;
  }

  private async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    this.report("GitHub sign-in: waiting for VS Code to complete account approval.");
    try {
      await prepareGitHubSignIn(() => this.assertTrusted());
      this.assertTrusted();
      const session = await vscode.authentication.getSession("github", scopes, { createIfNone: true });
      this.assertTrusted();
      // The provider can announce a session before VS Code grants this extension
      // access to it. Reconnect again after getSession finishes that approval.
      this.report("GitHub sign-in completed; refreshing workspace access.");
      this.generation++;
      this.changed.fire();
      return session;
    } catch (error) {
      const failure = authenticationFailure(error);
      this.report(`GitHub sign-in: ${failure.code}.`);
      throw failure;
    }
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

/** Reduce provider failures to fixed categories without retaining exception text. */
function authenticationFailure(error: unknown): HostError {
  if (error instanceof HostError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/cancelled|canceled|CancellationError/i.test(name) || /cancelled|canceled|did not consent/i.test(message)) {
    return new HostError("authentication_cancelled", "GitHub sign-in was cancelled. Connect again to retry.");
  }
  if (/timed out|timeout/i.test(message)) {
    return new HostError("authentication_timeout", "GitHub sign-in timed out. Retry from VS Code and check the GitHub Authentication output.");
  }
  if (/no authentication provider|authentication provider.*not registered/i.test(message)) {
    return new HostError("authentication_unavailable", "VS Code's GitHub Authentication provider is unavailable. Enable it and retry.");
  }
  return new HostError("authentication_failed", "VS Code could not complete GitHub sign-in. Check the GitHub Authentication output, then retry.");
}
