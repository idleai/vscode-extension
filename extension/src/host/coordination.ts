import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { RepositoryBinding } from '../history';
import { FolderConfiguration, HostConfiguration, resolveNativePath } from './configuration';
import { CoordinationClient } from './coordinationClient';
import { HostError, record } from './protocol';

/** One private metadata authority per folder, owned by the extension lifetime. */
export class CoordinationHost {
  private readonly clients = new Map<string, Promise<CoordinationClient>>();
  private retiring: Promise<void> = Promise.resolve();
  private generation = 0;
  private closed = false;
  private readonly identity: Promise<string>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly configuration: HostConfiguration) {
    const saved = context.globalState.get<string>('coordination.localContributor');
    const id = saved ?? randomUUID();
    this.identity = saved ? Promise.resolve(id) : Promise.resolve(context.globalState.update('coordination.localContributor', id)).then(() => id);
  }

  async read(config: FolderConfiguration, binding: RepositoryBinding, params: unknown, signal: AbortSignal): Promise<unknown> {
    this.configuration.assertTrusted();
    if (!record(params) || typeof params.command !== 'string' || params.command.length > 16_384) {
      throw new HostError('invalid_request', 'Expected a bounded coordination read.');
    }
    let command: unknown;
    try { command = JSON.parse(params.command); } catch { throw new HostError('invalid_request', 'Invalid coordination read.'); }
    if (!record(command) || !['snapshot', 'presence', 'catch_up'].includes(String(command.kind))) {
      throw new HostError('denied', 'This coordination operation is unavailable.');
    }
    const generation = this.generation;
    let opening = this.clients.get(binding.workspace_id);
    if (!opening) {
      opening = this.open(config, binding, generation);
      this.clients.set(binding.workspace_id, opening);
      void opening.catch(() => { if (this.clients.get(binding.workspace_id) === opening) this.clients.delete(binding.workspace_id); });
    }
    let client = await opening;
    this.assertCurrent(generation, signal);
    if (!client.isRunning()) {
      if (this.clients.get(binding.workspace_id) === opening) {
        const previous = client;
        opening = previous.shutdown().then(() => this.open(config, binding, generation));
        this.clients.set(binding.workspace_id, opening);
        void opening.catch(() => { if (this.clients.get(binding.workspace_id) === opening) this.clients.delete(binding.workspace_id); });
      } else opening = this.clients.get(binding.workspace_id)!;
      client = await opening;
      this.assertCurrent(generation, signal);
    }
    if (command.kind === 'presence') await this.publishPresence(client, config, binding, signal);
    // A watch owns no cursor in JavaScript. Rust supplies the original exact cursor.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const raw = await client.request(params.command, signal);
      this.assertCurrent(generation, signal);
      if (params.watch !== true || command.kind !== 'catch_up' || Date.now() >= deadline) return { native: raw, now_ms: Date.now() };
      const result = JSON.parse(raw).result.Ok;
      if (result.kind !== 'events' || result.data.events.length) return { native: raw, now_ms: Date.now() };
      await delay(1000, undefined, { signal });
      this.assertCurrent(generation, signal);
    }
  }

  private async publishPresence(client: CoordinationClient, config: FolderConfiguration, binding: RepositoryBinding, signal: AbortSignal): Promise<void> {
    const subject = await this.identity;
    const active = vscode.window.activeTextEditor?.document.uri;
    const relative = active && active.scheme === config.folder.uri.scheme && active.authority === config.folder.uri.authority
      ? path.relative(config.cwd, active.fsPath).split(path.sep).join('/') : undefined;
    const file = relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) && relative.length <= 1024 && !/[\x00-\x1f\x7f]/.test(relative) ? relative : null;
    const now = Date.now();
    await client.request(JSON.stringify({ kind: 'publish_presence', data: {
      connection_id: `vscode:${process.pid}`, contributor_id: `local-contributor:${subject}`,
      repository_id: binding.repository_id, branch: null, file, host_id: null, summary: 'VS Code',
      observed_at: String(now), valid_until: String(now + 45_000),
    } }), signal);
  }

  private assertCurrent(generation: number, signal?: AbortSignal): void {
    this.configuration.assertTrusted();
    if (this.closed || generation !== this.generation || signal?.aborted) throw new HostError('cancelled', 'Coordination context changed.');
  }

  private async open(config: FolderConfiguration, binding: RepositoryBinding, generation: number): Promise<CoordinationClient> {
    await this.retiring;
    const subject = await this.identity;
    this.assertCurrent(generation);
    const key = createHash('sha256').update(binding.workspace_id).digest('hex');
    const directory = path.join(this.context.globalStorageUri.fsPath, 'coordination', key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'host.json');
    await writeFile(file, JSON.stringify({
      state_directory: path.join(directory, 'state'), chain_directory: config.chainDirectory,
      device_directory: path.join(directory, 'device'),
      workspace: { id: binding.workspace_id, name: config.folder.name, chain: binding.chain,
        mode: { kind: 'standalone', repository: { id: binding.repository_id, name: config.folder.name, remote: null } } },
      contributor: { contributor_id: `local-contributor:${subject}`, authenticated_as: { issuer: 'idle-vscode-local', subject } },
      runtime: null, credential_variable: null, discovery_repository: null, resume_sharing: false,
    }), { mode: 0o600 });
    this.assertCurrent(generation);
    const client = new CoordinationClient();
    client.start(resolveNativePath('', this.context.extensionUri.fsPath, 'idle-coordination'), { args: ['--config', file], cwd: config.cwd });
    return client;
  }

  reset(): void {
    this.generation++;
    const clients = [...this.clients.values()];
    this.clients.clear();
    const previous = this.retiring;
    this.retiring = previous.then(async () => {
      const results = await Promise.allSettled(clients.map(client => client.then(value => value.shutdown(), () => {})));
      if (results.some(result => result.status === 'rejected')) throw new HostError('shutdown_failed', 'A coordinator did not close.');
    });
    void this.retiring.catch(() => {});
  }

  shutdown(): Promise<void> { this.closed = true; this.reset(); return this.retiring; }
}
