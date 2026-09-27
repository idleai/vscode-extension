import * as vscode from "vscode";
import { HostConfiguration } from "./configuration";
import { StdioClient } from "./processes";
import { NativeWorker } from "./nativeWorker";
import { HostError } from "./protocol";

/** One service per explicit file-owning folder, independent of view lifetimes. */
export class NativeServices implements vscode.Disposable {
  private readonly clients = new Map<string, StdioClient>();
  private readonly peers = new Set<NativeWorker>();
  private readonly retiring = new Map<StdioClient | NativeWorker, Promise<void>>();
  private closed = false;

  constructor(private readonly configuration: HostConfiguration) {}

  request(resource: vscode.Uri, body: unknown, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    return this.client(resource).request(body, options);
  }

  requestJson(resource: vscode.Uri, body: Buffer | readonly Buffer[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    return this.client(resource).requestJson(body, options);
  }

  /** Peer protocol messages are interpreted by Rust; this host only owns IPC. */
  startPeer(resource: vscode.Uri): NativeWorker {
    if (this.closed) throw new HostError("host_closed", "The extension host is shutting down.");
    const config = this.configuration.forResource(resource);
    const worker = new NativeWorker(this.configuration.binary(config, "peer"), { cwd: config.cwd });
    this.peers.add(worker);
    return worker;
  }

  private client(resource: vscode.Uri): StdioClient {
    if (this.closed) throw new HostError("host_closed", "The extension host is shutting down.");
    const config = this.configuration.forResource(resource);
    const key = config.folder.uri.toString();
    let client = this.clients.get(key);
    if (!client) { client = new StdioClient(); this.clients.set(key, client); }
    client.ensureStarted(this.configuration.binary(config, "service"), { cwd: config.cwd });
    return client;
  }

  /** Configuration/folder changes terminate in-flight work before using a new binding. */
  reset(): void {
    for (const client of [...this.clients.values(), ...this.peers]) {
      const closing = client.shutdown();
      this.retiring.set(client, closing);
      void closing.then(() => this.retiring.delete(client), () => {});
    }
    this.clients.clear();
    this.peers.clear();
  }

  dispose(): void { this.closed = true; this.reset(); }

  async shutdown(): Promise<void> {
    this.dispose();
    const results = await Promise.allSettled(this.retiring.values());
    if (results.some(result => result.status === "rejected")) {
      throw new HostError("shutdown_failed", "A native adapter did not exit before the shutdown deadline.");
    }
  }
}
