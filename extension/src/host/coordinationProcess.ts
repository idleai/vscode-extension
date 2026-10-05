import { CoordinationClient, CredentialPurpose } from './coordinationClient';
import { NativeServices } from './nativeHost';
import { HostError, record } from './protocol';

interface Installation {
  cwd: string;
  configuration: unknown;
}

/** Owns one coordinator channel, including startup, replacement and retirement. */
export class CoordinationProcess {
  private client?: CoordinationClient;
  private opening?: Promise<CoordinationClient>;
  private closing?: Promise<void>;

  constructor(private readonly native: NativeServices,
    private readonly prepare: () => Promise<Installation>,
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
    this.validate();
    const client = new CoordinationClient({}, this.credential,
      this.native.connection(installation.cwd, 'coordination', installation.configuration));
    this.client = client;
    try {
      client.start();
      const response: unknown = JSON.parse(await client.request('{"kind":"versions"}', undefined, 60_000));
      const versions = record(response) && record(response.result) ? response.result.Ok : undefined;
      if (!record(versions) || ['service', 'repository_api', 'invitation', 'saved_sharing'].some(key => versions[key] !== 1)) {
        throw new HostError('incompatible_host', 'The native coordinator uses an incompatible protocol.');
      }
      this.validate();
      return client;
    } catch (error) { await client.shutdown(); throw error; }
  }

  shutdown(command?: 'stop' | 'suspend'): Promise<void> {
    return this.closing ??= (async () => {
      try {
        if (!command) await this.client?.shutdown();
        const client = command === 'stop' ? await this.recover(this.opening)
          : await this.opening?.catch(error => { if (command) throw error; return undefined; });
        if (command && client?.isRunning()) await client.request(JSON.stringify({ kind: command }), undefined, 60_000);
      } finally { await this.client?.shutdown(); }
    })();
  }
}
