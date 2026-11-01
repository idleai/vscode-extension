import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import { bindingKey, RepositoryBinding } from '../history/contracts';
import { FolderConfiguration, HostConfiguration } from './configuration';
import { HostCallContext } from './effects';
import { HostError, record } from './protocol';
import { RuntimeHost } from './runtime';

interface SavedRequest { id: string; operation: unknown; command: string }
interface SavedState { version: 1; drafts: string; requests: SavedRequest[] }

/** Saved editor intent and attributed calls over the existing runner invitation. */
export class SessionHost {
  private generation = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly snapshots = new Map<string, string>();

  constructor(private readonly storage: vscode.Memento, private readonly configuration: HostConfiguration,
    private readonly runtime: RuntimeHost, private readonly contributor: () => Promise<string>) {}

  async call(config: FolderConfiguration, binding: RepositoryBinding, params: unknown, context: HostCallContext): Promise<unknown> {
    const generation = this.generation;
    const contributor = await this.contributor();
    this.current(generation, context.signal);
    if (!record(params) || !record(params.operation) || typeof params.command !== 'string'
      || Buffer.byteLength(params.command) > 128 * 1024) throw new HostError('invalid_request', 'Invalid session request.');
    this.scope(params.operation.context, binding, contributor);
    let command: unknown;
    try { command = JSON.parse(params.command); } catch { throw new HostError('invalid_request', 'Invalid session request.'); }
    if (!record(command) || !['snapshot', 'create', 'submit', 'grant', 'request_status', 'input_status'].includes(String(command.kind))) {
      throw new HostError('invalid_request', 'Unsupported session operation.');
    }
    const action = params.operation.action;
    const mutation = record(action) && record(action.Mutate) ? action.Mutate : undefined;
    if (mutation) {
      const request = this.validateMutation(mutation, command, binding, contributor);
      await this.write(binding, contributor, saved => {
        const previous = saved.requests.find(entry => entry.id === request.id);
        if (previous && (previous.command !== params.command || JSON.stringify(previous.operation) !== JSON.stringify(params.operation))) {
          throw new HostError('conflict', 'This request identity already belongs to another session action.');
        }
        if (!previous) {
          if (saved.requests.length >= 64) throw new HostError('busy', 'Recover pending session actions before sending another.');
          saved.requests.push({ id: request.id, operation: params.operation, command: String(params.command) });
        }
      });
      this.current(generation, context.signal);
    } else if (['create', 'submit', 'grant'].includes(String(command.kind))) {
      throw new HostError('denied', 'A session write requires its original saved request.');
    }
    const key = `${this.key(binding, contributor)}:${context.session}`;
    const previous = this.snapshots.get(key);
    const watch = record(action) && record(action.Watch);
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (watch) await delay(1500, undefined, { signal: context.signal });
      this.current(generation, context.signal);
      let result: unknown;
      try { result = await this.runtime.session(config, binding, params.command, context.signal); }
      catch (error) {
        if (!mutation && error instanceof HostError && ['unavailable', 'denied', 'expired', 'incompatible_host'].includes(error.code)) {
          this.current(generation, context.signal);
          return { session: { error: { code: error.code === 'unavailable' ? 'disconnected' : error.code } }, changed: false };
        }
        throw error;
      }
      this.current(generation, context.signal);
      if (!record(result)) throw new HostError('invalid_data', 'Invalid session response.');
      const snapshot = record(result.snapshot);
      const digest = snapshot ? createHash('sha256').update(JSON.stringify([result.snapshot, result.inputs, result.transcripts, result.readiness])).digest('hex') : undefined;
      if (digest) this.snapshots.set(key, digest);
      if (!watch || !snapshot || !previous || digest !== previous || Date.now() >= deadline) {
        return { session: result, changed: !previous || digest !== previous };
      }
    }
  }

  async state(binding: RepositoryBinding, params: unknown, context: HostCallContext): Promise<unknown> {
    const generation = this.generation;
    const contributor = await this.contributor();
    this.current(generation, context.signal);
    if (!record(params)) throw new HostError('invalid_request', 'Invalid saved session state.');
    this.scope(params.context, binding, contributor);
    if (params.action === 'load') {
      await this.writes;
      this.current(generation, context.signal);
      const saved = this.read(binding, contributor);
      return { drafts: saved.drafts, requests: saved.requests.map(request => request.operation) };
    }
    if (params.action === 'store' && typeof params.drafts === 'string' && Buffer.byteLength(params.drafts) <= 2 * 1024 * 1024
      && Array.isArray(params.settled) && params.settled.every(id => typeof id === 'string')) {
      try { JSON.parse(params.drafts); } catch { throw new HostError('invalid_request', 'Invalid session drafts.'); }
      await this.write(binding, contributor, saved => {
        saved.drafts = String(params.drafts);
        saved.requests = saved.requests.filter(request => !(params.settled as string[]).includes(request.id));
      });
      this.current(generation, context.signal);
      return null;
    }
    throw new HostError('invalid_request', 'Invalid saved session state operation.');
  }

  private validateMutation(mutation: Record<string, unknown>, command: Record<string, unknown>, binding: RepositoryBinding, contributor: string): { id: string } {
    const request = mutation.request;
    const wire = command.request;
    if (!record(request) || !record(request.contributor) || !record(request.mutation)
      || request.workspace_id !== binding.workspace_id || request.contributor.contributor_id !== contributor
      || request.contributor.issuer !== 'idle-runtime-grant' || request.contributor.subject !== contributor
      || typeof request.mutation.request_id !== 'string' || !request.mutation.request_id || request.mutation.request_id.length > 256
      || !record(wire) || !record(wire.context) || !record(wire.context.contributor) || !record(wire.context.contributor.authenticated_as)
      || wire.api_version !== '1' || wire.control_fence !== null || wire.context.workspace_id !== binding.workspace_id
      || wire.context.request_id !== request.mutation.request_id || wire.context.expires_at !== String(request.mutation.expires_at_ms)
      || wire.context.contributor.contributor_id !== contributor || wire.context.contributor.authenticated_as.issuer !== 'idle-runtime-grant'
      || wire.context.contributor.authenticated_as.subject !== contributor
      || !this.matchesMutation(mutation.mutation, command, wire.body)) {
      throw new HostError('denied', 'This session action does not belong to the authenticated contributor.');
    }
    return { id: request.mutation.request_id };
  }

  private matchesMutation(intent: unknown, command: Record<string, unknown>, body: unknown): boolean {
    if (!record(intent) || Object.keys(intent).length !== 1) return false;
    if (record(intent.Submit)) return command.kind === 'submit' && isDeepStrictEqual(body, intent.Submit);
    if (record(intent.Create)) return command.kind === 'create' && intent.Create.parent == null
      && isDeepStrictEqual(body, { title: intent.Create.title, host_id: intent.Create.host_id });
    if (command.kind !== 'grant') return false;
    if (record(intent.Revoke)) return isDeepStrictEqual(body, { kind: 'revoke', grant_id: intent.Revoke.grant_id,
      expected_revision: String(intent.Revoke.expected_revision) });
    if (!record(intent.Invite) || !Array.isArray(intent.Invite.permissions)) return false;
    const permission: Record<string, string> = { Observe: 'observe', SubmitInput: 'submit_input', Invite: 'invite' };
    return isDeepStrictEqual(body, { kind: 'issue', grant_id: intent.Invite.grant_id, grantee: intent.Invite.grantee,
      scope: { kind: 'session', session_id: intent.Invite.session_id, permissions: intent.Invite.permissions.map(value => permission[String(value)]) },
      expires_at: intent.Invite.expires_at_ms == null ? null : String(intent.Invite.expires_at_ms) });
  }

  private scope(value: unknown, binding: RepositoryBinding, contributor: string): void {
    if (!record(value) || value.provider !== 'idle-local' || value.mode !== 'Standalone'
      || value.workspace_id !== binding.workspace_id || value.chain !== binding.chain || value.contributor_id !== contributor) {
      throw new HostError('denied', 'This session connection belongs to another workspace or contributor.');
    }
  }

  private read(binding: RepositoryBinding, contributor: string): SavedState {
    const saved = this.storage.get<SavedState>(this.key(binding, contributor));
    if (!saved) return { version: 1, drafts: '{}', requests: [] };
    if (saved.version !== 1 || typeof saved.drafts !== 'string' || !Array.isArray(saved.requests)) {
      throw new HostError('invalid_state', 'Saved session actions could not be read.');
    }
    return structuredClone(saved);
  }

  private write(binding: RepositoryBinding, contributor: string, change: (saved: SavedState) => void): Promise<void> {
    const next = this.writes.then(async () => {
      const saved = this.read(binding, contributor);
      change(saved);
      if (Buffer.byteLength(JSON.stringify(saved)) > 4 * 1024 * 1024) throw new HostError('busy', 'Saved session actions are full. Recover pending actions before continuing.');
      await this.storage.update(this.key(binding, contributor), saved);
    });
    this.writes = next.catch(() => {});
    return next;
  }

  private key(binding: RepositoryBinding, contributor: string): string {
    return `sessions.state.${createHash('sha256').update(JSON.stringify([bindingKey(binding), contributor])).digest('hex')}`;
  }

  private current(generation: number, signal: AbortSignal): void {
    this.configuration.assertTrusted();
    if (generation !== this.generation || signal.aborted) throw new HostError('cancelled', 'Session connection changed.');
  }

  reset(): void { this.generation++; this.snapshots.clear(); }
  async shutdown(): Promise<void> { this.reset(); await this.writes; }
}
