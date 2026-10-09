import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { bindingKey, RepositoryBinding } from '../history/contracts';
import { HostConfiguration, FolderConfiguration } from './configuration';
import { CoordinationClient } from './coordinationClient';
import { NativeServices } from './nativeHost';
import { HostError, record } from './protocol';

export interface RuntimeObservation { status: unknown; connected: boolean; observed_at: number; revision: number }
interface Connection {
  client: CoordinationClient; binding: RepositoryBinding; config: FolderConfiguration;
  status?: unknown; observed: number; revision: number; failures: number; retry: number;
  pending?: Promise<RuntimeObservation | undefined>; timer?: NodeJS.Timeout; closed: boolean;
}

/** Private runtime connections; the daemon owns workspace state and tunnel hosting. */
export class RuntimeHost {
  private readonly connections = new Map<string, Connection>();
  private readonly revisions = new Map<string, number>();
  private generation = 0;
  private closed = false;
  private updating: Promise<unknown> = Promise.resolve();
  private pairing = false;
  private readonly changed = new vscode.EventEmitter<RepositoryBinding>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly configuration: HostConfiguration,
    private readonly native: NativeServices, private readonly contributor: () => Promise<string>) {}

  async connectionRequest(binding: RepositoryBinding): Promise<string> {
    this.configuration.assertTrusted();
    return JSON.stringify({ version: 1, workspaceId: binding.workspace_id, repositoryId: binding.repository_id,
      chainId: binding.chain, clientId: await this.contributor() }, null, 2);
  }

  async connect(config: FolderConfiguration, binding: RepositoryBinding, invitation: string): Promise<void> {
    this.configuration.assertTrusted();
    if (this.pairing) throw new HostError('busy', 'A compute connection is already being checked.');
    const generation = this.generation;
    if (!invitation.startsWith('idle-runtime:') || Buffer.byteLength(invitation) > 32 * 1024) {
      throw new HostError('invalid_request', 'Paste the complete compute invitation from the daemon owner.');
    }
    this.pairing = true;
    let candidate: Connection | undefined;
    try {
      candidate = await this.open(config, binding, invitation.trim());
      await this.query(candidate);
      this.assertCurrent(generation);
      const key = this.key(binding);
      const previous = await this.update(async () => {
        this.assertCurrent(generation);
        const saved = await this.context.secrets.get(key);
        const savedStatus = this.context.globalState.get<unknown>(`${key}.status`);
        try {
          await this.context.secrets.store(key, invitation.trim());
          this.assertCurrent(generation);
          await this.context.globalState.update(`${key}.status`, candidate!.status);
          this.assertCurrent(generation);
        }
        catch (error) {
          if (saved) await this.context.secrets.store(key, saved); else await this.context.secrets.delete(key);
          await this.context.globalState.update(`${key}.status`, savedStatus);
          throw error;
        }
        const previous = this.connections.get(key);
        this.connections.set(key, candidate!);
        return previous;
      });
      await this.retire(previous);
      this.schedule(candidate);
      this.changed.fire(binding);
    } catch (error) { await this.retire(candidate); throw error; }
    finally { this.pairing = false; }
  }

  async snapshot(config: FolderConfiguration, binding: RepositoryBinding, signal?: AbortSignal): Promise<RuntimeObservation | undefined> {
    this.configuration.assertTrusted();
    if (this.closed || signal?.aborted) throw new HostError('cancelled', 'Compute connection cancelled.');
    const generation = this.generation;
    const key = this.key(binding);
    let connection = this.connections.get(key);
    if (!connection) {
      const invitation = await this.context.secrets.get(key);
      this.assertCurrent(generation);
      if (!invitation) return undefined;
      const opened = await this.open(config, binding, invitation);
      try { this.assertCurrent(generation); }
      catch (error) { await this.retire(opened); throw error; }
      // Concurrent view reads share the first installed channel.
      connection = this.connections.get(key);
      if (connection) await this.retire(opened);
      else { connection = opened; this.connections.set(key, connection); }
      this.schedule(connection);
    }
    if (Date.now() < connection.retry) return this.observation(connection);
    connection.pending ??= this.refresh(connection).finally(() => { connection!.pending = undefined; });
    const observation = await connection.pending;
    this.assertCurrent(generation);
    if (signal?.aborted) throw new HostError('cancelled', 'Compute connection cancelled.');
    return observation;
  }

  async disconnect(binding: RepositoryBinding): Promise<void> {
    this.configuration.assertTrusted();
    this.generation++;
    const key = this.key(binding);
    const connection = this.connections.get(key);
    this.connections.delete(key);
    await this.update(async () => {
      await this.context.secrets.delete(key);
      await this.context.globalState.update(`${key}.status`, undefined);
    });
    await this.retire(connection);
    this.changed.fire(binding);
  }

  private async open(config: FolderConfiguration, binding: RepositoryBinding, invitation: string): Promise<Connection> {
    const clientId = await this.contributor();
    const client = new CoordinationClient({}, undefined, this.native.connection(config.cwd, 'runtime', {
      invitation, workspace_id: binding.workspace_id, repository_id: binding.repository_id,
      chain_id: binding.chain, client_id: clientId,
    }));
    client.start();
    const status = this.context.globalState.get<unknown>(`${this.key(binding)}.status`);
    return { client, binding, config, status, observed: Date.now(), revision: this.nextRevision(binding),
      failures: 1, retry: 0, closed: false };
  }

  private async query(connection: Connection): Promise<void> {
    if (connection.closed) throw new HostError('cancelled', 'Compute connection closed.');
    if (!connection.client.isRunning()) connection.client.start();
    if (this.native.supports && !await this.native.supports('runtime.workspace')) {
      throw new HostError('incompatible_host', 'Install the native host with compute connection support, or set idle.native.hostPath to that build.');
    }
    const response: unknown = JSON.parse(await connection.client.request('{"kind":"status"}', undefined, 45_000));
    const result = record(response) && record(response.result) ? response.result.Ok : undefined;
    if (!record(result) || !record(result.status)) throw new HostError('invalid_data', 'Invalid compute host response.');
    if (connection.closed) throw new HostError('cancelled', 'Compute connection closed.');
    connection.status = result.status;
    connection.observed = Math.max(connection.observed, Date.now());
    connection.revision = this.nextRevision(connection.binding);
    connection.failures = 0;
    connection.retry = connection.observed + 10_000;
  }

  private async refresh(connection: Connection): Promise<RuntimeObservation | undefined> {
    try {
      await this.query(connection);
      await this.update(async () => {
        if (!connection.closed && this.connections.get(this.key(connection.binding)) === connection) {
          await this.context.globalState.update(`${this.key(connection.binding)}.status`, connection.status);
        }
      });
    }
    catch {
      connection.observed = Math.max(connection.observed, Date.now());
      connection.revision = this.nextRevision(connection.binding);
      connection.failures++;
      connection.retry = connection.observed + Math.min(30_000, 1000 * 2 ** Math.min(connection.failures, 5));
    }
    return this.observation(connection);
  }

  private observation(connection: Connection): RuntimeObservation | undefined {
    return connection.status ? { status: connection.status, connected: !connection.closed && connection.failures === 0,
      observed_at: connection.observed, revision: connection.revision } : undefined;
  }

  private nextRevision(binding: RepositoryBinding): number {
    const key = this.key(binding);
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    return revision;
  }

  private schedule(connection: Connection): void {
    if (this.closed || connection.closed || connection.timer) return;
    connection.timer = setTimeout(() => {
      connection.timer = undefined;
      void this.snapshot(connection.config, connection.binding).then(() => {
        if (!connection.closed) this.changed.fire(connection.binding);
      }).catch(() => {}).finally(() => this.schedule(connection));
    }, 10_000);
    connection.timer.unref();
  }

  private key(binding: RepositoryBinding): string {
    return `runtime.connection.${createHash('sha256').update(bindingKey(binding)).digest('hex')}`;
  }

  private update<T>(work: () => Promise<T>): Promise<T> {
    const result = this.updating.then(work);
    this.updating = result.then(() => {}, () => {});
    return result;
  }

  private assertCurrent(generation: number): void {
    this.configuration.assertTrusted();
    if (this.closed || generation !== this.generation) throw new HostError('cancelled', 'Compute workspace changed.');
  }

  private async retire(connection?: Connection): Promise<void> {
    if (!connection || connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.timer);
    await connection.client.shutdown();
  }

  async reset(): Promise<void> {
    this.generation++;
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all([...connections.map(connection => this.retire(connection)), this.updating]);
  }

  async shutdown(): Promise<void> { this.closed = true; await this.reset(); this.changed.dispose(); }
}
