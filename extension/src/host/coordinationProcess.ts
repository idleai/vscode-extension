import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoordinationClient, CredentialPurpose } from './coordinationClient';
import { resolveNativePath } from './configuration';
import { NativeProcessOptions } from './nativeProcess';
import { HostError } from './protocol';

interface Installation {
  directory: string;
  cwd: string;
  configuration: unknown;
}

/** Owns one coordinator installation, including startup, replacement and retirement. */
export class CoordinationProcess {
  private client?: CoordinationClient;
  private opening?: Promise<CoordinationClient>;
  private closing?: Promise<void>;

  constructor(private readonly extensionPath: string,
    private readonly prepare: () => Promise<Installation>,
    private readonly processOptions: NativeProcessOptions = {},
    private readonly credential?: (purpose: CredentialPurpose) => Promise<string | undefined>,
    private readonly validate: () => void = () => {}) {}

  acquire(restart = false): Promise<CoordinationClient> {
    if (this.closing) return Promise.reject(new HostError('cancelled', 'Coordination was stopped.'));
    if (!this.opening) this.opening = this.open();
    else if (restart) this.opening = this.recover(this.opening);
    return this.opening;
  }

  private async recover(previous?: Promise<CoordinationClient>): Promise<CoordinationClient> {
    const client = await previous?.catch(() => undefined);
    if (client?.isRunning()) return client;
    await this.client?.shutdown();
    return this.open();
  }

  private async open(): Promise<CoordinationClient> {
    this.validate();
    const installation = await this.prepare();
    await mkdir(installation.directory, { recursive: true, mode: 0o700 });
    const file = path.join(installation.directory, 'host.json');
    await writeFile(file, JSON.stringify(installation.configuration), { mode: 0o600 });
    this.validate();
    const client = new CoordinationClient(this.processOptions, this.credential);
    this.client = client;
    try {
      client.start(resolveNativePath('', this.extensionPath, 'idle-coordination'), {
        args: ['--config', file], cwd: installation.cwd,
      });
      await client.request('{"kind":"versions"}', undefined, 60_000);
      return client;
    } catch (error) { await client.shutdown(); throw error; }
  }

  shutdown(command?: 'stop' | 'suspend'): Promise<void> {
    return this.closing ??= (async () => {
      try {
        const client = command === 'stop' ? await this.recover(this.opening)
          : await this.opening?.catch(error => { if (command) throw error; return undefined; });
        if (command && client?.isRunning()) await client.request(JSON.stringify({ kind: command }), undefined, 60_000);
      } finally { await this.client?.shutdown(); }
    })();
  }
}
