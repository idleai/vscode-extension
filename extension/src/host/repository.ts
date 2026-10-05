import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import { RepositoryBinding } from '../history';
import { bindingKey } from '../history/contracts';
import { FolderConfiguration, HostConfiguration } from './configuration';
import { NativeServices } from './nativeHost';
import { HostCredentials } from './credentials';
import { HostCallContext } from './effects';
import { StdioClient } from './processes';
import { HostError, record } from './protocol';

interface NativeSnapshot { repository: Record<string, unknown>; projections: unknown[] }
interface Connection {
  readonly key: string;
  readonly binding: RepositoryBinding;
  readonly client: StdioClient;
  readonly generation: number;
  readonly audience: string;
  pending?: PendingRead;
  cached?: { audience: string; value: NativeSnapshot; until: number };
}

interface PendingRead {
  work: Promise<NativeSnapshot>;
  refresh: boolean;
  waiters: number;
  settled: boolean;
}

type ReadMode = 'projection' | 'poll' | 'refresh';

/** Extension-owned native repository reads. Git/GitHub interpretation lives in Rust. */
export class RepositoryHost {
  private readonly connections = new Map<string, Connection>();
  private readonly retiring = new Set<Promise<void>>();
  private generation = 0;
  private closed = false;
  private preferences: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext, private readonly configuration: HostConfiguration,
    private readonly credentials: HostCredentials, private readonly contributor: () => Promise<string>,
    private readonly native: NativeServices) {}

  async read(config: FolderConfiguration, binding: RepositoryBinding, params: unknown, call: HostCallContext): Promise<unknown> {
    this.configuration.assertTrusted();
    if (!record(params) || !record(params.operation) || !record(params.operation.context) || !record(params.operation.context.connection)) {
      throw new HostError('invalid_request', 'Expected a bound repository read.');
    }
    const operation = params.operation;
    const context = operation.context as Record<string, unknown>;
    const connection = context.connection as Record<string, unknown>;
    const generation = this.generation;
    const contributor = await this.contributor();
    this.assertCurrent(generation, call.signal);
    if (connection.provider !== 'idle-local' || connection.workspace !== binding.workspace_id || connection.chain !== binding.chain
      || connection.contributor !== contributor || context.repository_id !== binding.repository_id) {
      throw new HostError('binding_mismatch', 'This repository request belongs to a different connection.');
    }
    const key = this.preferenceKey(binding, contributor, call.viewKind ?? call.session);
    if (record(operation.action) && Object.keys(operation.action).length === 1 && Object.hasOwn(operation.action, 'Remember')) {
      const selected = operation.action.Remember;
      if (selected !== null && (typeof selected !== 'string' || !/^[0-9a-f]{64}$/.test(selected))) throw new HostError('invalid_request', 'A recorded session requires its full logical identity.');
      // Accepted preference writes finish after a view closes and retain arrival order.
      const save = this.preferences.then(() => this.context.workspaceState.update(key, selected));
      this.preferences = save.catch(() => {});
      await save;
      return { Ok: 'Remembered' };
    }
    if (operation.action !== 'Read' && operation.action !== 'Poll' && operation.action !== 'SignIn') throw new HostError('invalid_request', 'Unknown repository operation.');
    if (operation.action === 'SignIn') {
      await this.credentials.repositorySession(true);
      this.assertCurrent(generation, call.signal);
    }
    const value = await this.snapshot(config, binding, call.signal, operation.action === 'Poll' ? 'poll' : 'refresh');
    this.assertCurrent(generation, call.signal);
    await this.preferences;
    this.assertCurrent(generation, call.signal);
    const selected = this.context.workspaceState.get<unknown>(key);
    const selected_session = typeof selected === 'string' && /^[0-9a-f]{64}$/.test(selected) ? selected : null;
    return { Ok: { Snapshot: { snapshot: value.repository, selected_session } } };
  }

  /** Share native reads between surfaces while retaining each caller's lifetime. */
  async snapshot(config: FolderConfiguration, binding: RepositoryBinding, signal: AbortSignal, mode: ReadMode = 'projection'): Promise<NativeSnapshot> {
    this.configuration.assertTrusted();
    const generation = this.generation;
    const session = await this.credentials.repositorySession();
    this.assertCurrent(generation, signal);
    const audience = createHash('sha256').update(JSON.stringify([session?.account.id, session?.accessToken])).digest('hex');
    const key = bindingKey(binding);
    let connection = this.connections.get(key);
    if (connection && connection.audience !== audience) {
      this.connections.delete(key);
      this.retire(connection.client);
      connection = undefined;
    }
    if (!connection) {
      const client = new StdioClient({}, this.native.connection(config.cwd, 'repository', {
        scope: binding, root: config.cwd, chain_directory: config.chainDirectory,
      }));
      client.start();
      connection = { key, binding, client, generation, audience };
      this.connections.set(key, connection);
    }
    const selected = connection;
    if (mode === 'projection' && selected.cached && selected.cached.until > Date.now()) return selected.cached.value;
    let pending = selected.pending;
    if (!pending) {
      const credentials = session ? { account: session.account.label, token: session.accessToken } : null;
      const work = selected.client.request({ credentials, refresh_github: mode === 'refresh' }, { timeoutMs: 65_000 }).then(result => {
        this.assertConnection(selected);
        if (!record(result) || !record(result.Ok) || !record(result.Ok.repository) || !Array.isArray(result.Ok.projections)
          || !isDeepStrictEqual(result.Ok.repository.scope, binding)) {
          throw new HostError('invalid_response', 'The repository reader did not return a snapshot for this binding. Refresh to retry.');
        }
        return result.Ok as unknown as NativeSnapshot;
      });
      pending = { work, refresh: mode === 'refresh', waiters: 0, settled: false };
      selected.pending = pending;
      const reading = pending;
      void work.then(value => {
        reading.settled = true;
        if (selected.pending === reading) selected.cached = { audience, value, until: Date.now() + 2000 };
      }, () => {
        reading.settled = true;
        if (this.connections.get(key) === selected && selected.pending === reading) {
          this.connections.delete(key);
          this.retire(selected.client);
        }
      }).finally(() => { if (selected.pending === reading) selected.pending = undefined; });
    }
    const result = await this.wait(selected, pending, signal);
    this.assertCurrent(generation, signal);
    this.assertConnection(selected);
    // An explicit refresh arriving during an automatic read must revalidate GitHub.
    if (mode === 'refresh' && !pending.refresh) return this.snapshot(config, binding, signal, mode);
    return result;
  }

  private wait(connection: Connection, pending: PendingRead, signal: AbortSignal): Promise<NativeSnapshot> {
    pending.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const settle = (error?: unknown, value?: NativeSnapshot) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        pending.waiters--;
        if (!pending.settled && pending.waiters === 0 && this.connections.get(connection.key) === connection) {
          this.connections.delete(connection.key);
          this.retire(connection.client);
        }
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => settle(new HostError('cancelled', 'The repository view closed.'));
      signal.addEventListener('abort', abort, { once: true });
      void pending.work.then(value => settle(undefined, value), error => settle(error));
      if (signal.aborted) abort();
    });
  }

  private preferenceKey(binding: RepositoryBinding, contributor: string, view: string): string {
    return 'repository.selection:' + createHash('sha256').update(JSON.stringify([bindingKey(binding), contributor, view])).digest('hex');
  }

  private assertCurrent(generation: number, signal?: AbortSignal): void {
    this.configuration.assertTrusted();
    if (this.closed || generation !== this.generation || signal?.aborted) throw new HostError('cancelled', 'The repository context changed.');
  }

  private assertConnection(connection: Connection): void {
    this.assertCurrent(connection.generation);
    if (this.connections.get(connection.key) !== connection) throw new HostError('cancelled', 'The repository reader was replaced.');
  }

  private retire(client: StdioClient): void {
    const work = client.shutdown();
    this.retiring.add(work);
    void work.then(() => this.retiring.delete(work), () => {});
  }

  reset(): void {
    this.generation++;
    for (const connection of this.connections.values()) this.retire(connection.client);
    this.connections.clear();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.reset();
    await this.preferences;
    const results = await Promise.allSettled(this.retiring);
    if (results.some(result => result.status === 'rejected')) throw new HostError('shutdown_failed', 'A repository reader did not close.');
  }
}
