import * as vscode from "vscode";
import { HostConfiguration } from "./configuration";
import { NativeWorker } from "./nativeWorker";
import { HostError } from "./protocol";

/** Peer workers belong to explicit file-owning folders and extension lifetimes. */
export class NativeServices implements vscode.Disposable {
  private readonly peers = new Set<NativeWorker>();
  private readonly retiring = new Map<NativeWorker, Promise<void>>();
  private closed = false;

  constructor(private readonly configuration: HostConfiguration) {}

  /** Peer protocol messages are interpreted by Rust; this host only owns IPC. */
  startPeer(resource: vscode.Uri): NativeWorker {
    if (this.closed) throw new HostError("host_closed", "The extension host is shutting down.");
    const config = this.configuration.forResource(resource);
    const worker = new NativeWorker(this.configuration.peerBinary(config), { cwd: config.cwd });
    this.peers.add(worker);
    return worker;
  }

  /** Configuration/folder changes terminate in-flight work before using a new binding. */
  reset(): void {
    for (const client of this.peers) {
      const closing = client.shutdown();
      this.retiring.set(client, closing);
      void closing.then(() => this.retiring.delete(client), () => {});
    }
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
