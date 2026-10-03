import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { RepositoryBinding } from '../history';
import { HostError, record } from './protocol';

const MAX_STATE_BYTES = 4 * 1024 * 1024;

/** Private, ordered storage for editor drafts and exact outgoing configuration writes. */
export class ConfigurationJournal {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  private file(binding: RepositoryBinding, contributor: string, kind: string, id: string): string {
    const key = createHash('sha256').update(JSON.stringify([binding, contributor, kind, id])).digest('hex');
    return path.join(this.directory, key + '.json');
  }

  readDrafts(binding: RepositoryBinding, contributor: string, view: string): Promise<string> {
    return this.serial(async () => {
      const file = this.file(binding, contributor, 'draft', view);
      const value = await this.read(file) ?? '[]';
      validateDrafts(value, binding, contributor);
      return value;
    });
  }

  writeDrafts(binding: RepositoryBinding, contributor: string, view: string, value: string): Promise<void> {
    validateDrafts(value, binding, contributor);
    return this.serial(() => this.write(this.file(binding, contributor, 'draft', view), value));
  }

  prepare(binding: RepositoryBinding, contributor: string, id: string, command: string): Promise<void> {
    return this.serial(async () => {
      const file = this.file(binding, contributor, 'request', id);
      const previous = await this.read(file);
      if (previous !== undefined && previous !== command) throw new HostError('invalid_request', 'This save identity already belongs to another write.');
      if (previous === undefined) await this.write(file, command);
    });
  }

  settled(binding: RepositoryBinding, contributor: string, id: string): Promise<void> {
    return this.serial(async () => { await fs.rm(this.file(binding, contributor, 'request', id), { force: true }); });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }

  private async read(file: string): Promise<string | undefined> {
    try {
      const handle = await fs.open(file, 'r');
      try {
        if ((await handle.stat()).size > MAX_STATE_BYTES) throw new HostError('invalid_state', 'Saved configuration state is too large.');
        return await handle.readFile('utf8');
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(file: string, value: string): Promise<void> {
    if (Buffer.byteLength(value, 'utf8') > MAX_STATE_BYTES) throw new HostError('invalid_request', 'Configuration state is too large.');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(value, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      if (process.platform !== 'win32') {
        const parent = await fs.open(this.directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.rm(temporary, { force: true }); }
  }

  flush(): Promise<unknown> { return this.tail; }
}

function validateDrafts(value: string, binding: RepositoryBinding, contributor: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_STATE_BYTES) throw new HostError('invalid_request', 'Configuration drafts are too large.');
  let drafts: unknown;
  try { drafts = JSON.parse(value); } catch { throw new HostError('invalid_request', 'Invalid configuration drafts.'); }
  if (!Array.isArray(drafts) || drafts.length > 2) throw new HostError('invalid_request', 'Expected two independent document drafts.');
  const documents = new Set<string>();
  for (const draft of drafts) {
    if (!record(draft) || !record(draft.context) || !record(draft.value)
      || !['Settings', 'AgentRules'].includes(String(draft.document)) || documents.has(String(draft.document))
      || draft.context.provider !== 'idle-local' || draft.context.mode !== 'Standalone'
      || draft.context.workspace_id !== binding.workspace_id || draft.context.chain !== binding.chain
      || draft.context.contributor_id !== contributor || typeof draft.value.json !== 'string'
      || Buffer.byteLength(draft.value.json, 'utf8') > 1024 * 1024 || draft.value.schema_version !== 1) {
      throw new HostError('invalid_request', 'Configuration draft scope or document is invalid.');
    }
    documents.add(String(draft.document));
  }
}
