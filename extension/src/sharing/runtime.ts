import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoordinationClient, CredentialPurpose } from '../host/coordinationClient';
import { resolveNativePath } from '../host/configuration';
import { HostError } from '../host/protocol';
import type { NativeProcessOptions } from '../host/nativeProcess';
import type { ScopeChoice, SharingScope } from './scope';
import type { Device, Invitation, JoinRequest, SavedSharing, SharingStatus } from './types';

export interface SharingOptions {
  key: string;
  account: string;
  chain: string;
  cwd: string;
  name: string;
  stateDirectory: string;
  deviceDirectory: string;
  credential(purpose: CredentialPurpose): Promise<string | undefined>;
  changed(value: SharingStatus, durable: boolean): void;
  saveEnabled(enabled: boolean): Promise<void>;
}

/** VS Code presents approvals; the native coordinator owns every sharing transition. */
export class NativeSharing {
  private client: CoordinationClient;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private stopping?: Promise<void>;
  private closed = false;
  private readonly lifetime = new AbortController();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private value: SharingStatus = { enabled: false, hosting: false, peers: [] };

  constructor(private readonly options: SharingOptions, private readonly extensionPath: string,
    private readonly processOptions: NativeProcessOptions = {}) {
    this.client = new CoordinationClient(this.processOptions, purpose => options.credential(purpose));
  }

  status(): SharingStatus { return this.value; }
  joinRequest(): Promise<string> { return this.call('join_request'); }
  inspectRequest(text: string): Promise<JoinRequest> { return this.call('inspect_request', text); }
  inspectInvitation(text: string): Promise<Invitation> { return this.call('inspect_invitation', text); }
  sharingScope(): Promise<SharingScope | undefined> { return this.call('sharing_scope'); }
  devices(): Promise<Device[]> { return this.call('devices'); }
  async hostHistory(request: string, scope: ScopeChoice): Promise<string> {
    return this.change('host', { request, scope: nativeScope(scope) });
  }
  async joinHistory(invitation: string, scope: ScopeChoice): Promise<void> {
    await this.change('join', { invitation, scope: nativeScope(scope) });
  }
  async changeScope(scope: ScopeChoice): Promise<void> { await this.change('scope', nativeScope(scope)); }
  async revoke(fingerprint: string): Promise<void> { await this.change('revoke', fingerprint); }
  async reconnect(): Promise<void> { await this.restartIfNeeded(); await this.change('reconnect'); }
  async resume(): Promise<void> { await this.restartIfNeeded(); await this.change('resume'); }
  async importSaved(saved: SavedSharing): Promise<void> { await this.call('import_sharing', saved); }
  async importCleanup(markers: string[]): Promise<void> { await this.call('import_cleanup', markers); }
  async cleanup(): Promise<void> { await this.call('cleanup'); }
  async configureDirectory(repository?: string): Promise<void> { await this.call('configure_directory', repository ?? null); }
  async discover(): Promise<void> { await this.call('discover'); }

  private async restartIfNeeded(): Promise<void> {
    if (this.closed) throw new HostError('cancelled', 'Sharing was stopped.');
    if (this.opening && !this.client.isRunning()) {
      await this.opening.catch(() => {});
      await this.client.shutdown();
      this.client = new CoordinationClient(this.processOptions, purpose => this.options.credential(purpose));
      this.opening = undefined;
    }
  }

  private async change<T>(kind: string, data?: unknown): Promise<T> {
    try { return await this.call<T>(kind, data); }
    finally {
      if (!this.closed) {
        await this.refresh();
        await this.options.saveEnabled(this.value.enabled);
      }
    }
  }

  private async call<T>(kind: string, data?: unknown): Promise<T> {
    if (this.closed) throw new HostError('cancelled', 'Sharing was stopped.');
    await (this.opening ??= this.open());
    const raw = await this.client.request(JSON.stringify({ kind, data }), this.lifetime.signal, 60_000);
    return JSON.parse(raw).result.Ok as T;
  }

  private async open(): Promise<void> {
    const options = this.options;
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    const file = path.join(options.stateDirectory, 'host.json');
    await writeFile(file, JSON.stringify({
      state_directory: path.join(options.stateDirectory, 'state'), chain_directory: options.chain,
      device_directory: options.deviceDirectory,
      workspace: { id: options.key, name: options.name, chain: options.key,
        mode: { kind: 'standalone', repository: { id: options.key, name: options.name, remote: null } } },
      contributor: { contributor_id: options.account, authenticated_as: { issuer: 'vscode-github', subject: options.account } },
      runtime: null, host_credentials: true, credential_variable: null, discovery_repository: null, resume_sharing: false,
    }), { mode: 0o600 });
    this.client.start(resolveNativePath('', this.extensionPath, 'idle-coordination'), { args: ['--config', file], cwd: options.cwd });
    await this.client.request('{"kind":"versions"}', undefined, 60_000);
    if (!this.closed) this.schedule();
  }

  private async refresh(): Promise<void> {
    const value = await this.call<SharingStatus>('sharing_status');
    if (this.closed) return;
    const durable = value.durable_changes !== this.value.durable_changes && !!value.durable_changes;
    value.peers = value.peers.map(peer => ({ ...peer, state: displayState(peer.state), progress: peer.progress ?? undefined }));
    value.scope ??= undefined;
    this.value = value;
    this.options.changed(value, durable);
  }

  private schedule(): void {
    if (this.closed || this.timer || this.polling) return;
    this.timer = setTimeout(() => {
      this.timer = undefined; this.polling = true;
      void this.refresh().catch(() => {
        if (!this.closed) {
          this.value = { ...this.value, hosting: false, peers: [], message: 'Sharing service unavailable. Use Resume History Sharing to retry.' };
          this.options.changed(this.value, false);
        }
      }).finally(() => { this.polling = false; this.schedule(); });
    }, 1000);
    this.timer.unref();
  }

  suspend(): Promise<void> { return this.close('suspend'); }
  stop(): Promise<void> {
    return this.stopping ??= this.closing
      ? this.closing.catch(() => {}).then(() => new NativeSharing(this.options, this.extensionPath, this.processOptions).stop())
      : this.close('stop');
  }

  private close(kind: 'stop' | 'suspend'): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.lifetime.abort(); clearTimeout(this.timer);
    this.value = { ...this.value, enabled: false, hosting: false, peers: [] };
    this.closing = (async () => {
      try {
        if (kind === 'stop') {
          await this.opening?.catch(() => {});
          if (!this.client.isRunning()) {
            await this.client.shutdown();
            this.client = new CoordinationClient(this.processOptions, purpose => this.options.credential(purpose));
            this.opening = this.open();
          }
          await this.opening;
        } else await this.opening;
        if (this.client.isRunning()) await this.client.request(JSON.stringify({ kind }), undefined, 60_000);
      } finally { await this.client.shutdown(); }
    })();
    return this.closing;
  }
}

function nativeScope(scope: ScopeChoice): string { return scope === 'keep' ? 'keep' : scope ? 'all' : 'from_now'; }
function displayState(state: string): string {
  return ({ Reconciling: 'Catching up', MissingContent: 'Waiting for content', Waiting: 'Waiting to reconnect', Expired: 'Invitation expired' } as Record<string, string>)[state] ?? state;
}
export function createManager(options: SharingOptions, extensionPath: string): NativeSharing { return new NativeSharing(options, extensionPath); }
