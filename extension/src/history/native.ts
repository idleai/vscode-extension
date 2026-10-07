import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { StdioClient } from "../host/processes";
import { HostError, record } from "../host/protocol";
import { NativeServices } from "../host/nativeHost";
import * as vscode from "vscode";
import { HistoryBinding, HistoryFailure, HistoryPreview, HistoryProvider, HistoryRequest, parseRecord } from "./contracts";
import { ActivityPreview, ActivityRequest, parsePreview } from "../authorActivity/contracts";

/** Lazy history channel; every request uses the installed storage binding. */
export class NativeHistoryProvider implements HistoryProvider {
  private client: StdioClient;
  private closed = false;

  constructor(private readonly native: NativeServices, private readonly binding: HistoryBinding) {
    this.client = this.connect();
  }

  private connect(): StdioClient {
    return new StdioClient({}, this.native.connection(this.binding.root.fsPath, 'history', {
      repository: this.binding.repository, chain_directory: this.binding.chainDirectory,
      retained_directory: this.binding.retainedDirectory ?? null,
    }));
  }

  async resolve(request: HistoryRequest, signal: AbortSignal): Promise<HistoryPreview> {
    const response = await this.request(request, signal);
    if (record(response) && record(response.Err) && typeof response.Err.code === "string" && typeof response.Err.message === "string") {
      const candidates = Array.isArray(response.Err.candidates) ? response.Err.candidates.map(parseRecord) : [];
      throw new HistoryFailure(response.Err.code, response.Err.message, candidates);
    }
    if (!record(response) || !record(response.Ok) || !isDeepStrictEqual(response.Ok.request, request) || !Array.isArray(response.Ok.documents)) {
      throw new HostError("invalid_response", "The history adapter returned a different request.");
    }
    return response.Ok as unknown as HistoryPreview;
  }

  async query(query: unknown, signal: AbortSignal): Promise<unknown> {
    return this.request({ binding: this.binding.repository, query }, signal);
  }

  async projection(projection: unknown, signal: AbortSignal, inputs?: unknown[]): Promise<unknown> {
    return this.request({ binding: this.binding.repository, projection, inputs }, signal);
  }

  async activity(request: ActivityRequest, signal: AbortSignal): Promise<ActivityPreview> {
    const response = await this.request({ activity: request }, signal);
    if (record(response) && record(response.Err) && typeof response.Err.code === 'string' && typeof response.Err.message === 'string') {
      throw new HistoryFailure(response.Err.code, response.Err.message, Array.isArray(response.Err.candidates) ? response.Err.candidates.map(parseRecord) : []);
    }
    return parsePreview(record(response) ? response.Ok : undefined, request);
  }

  private async request(request: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      for (let attempt = 0; ; attempt++) {
        this.assertReadable(signal);
        this.client.ensureStarted();
        const response = await this.client.request(request, { signal });
        this.assertReadable(signal);
        if (attempt >= 3 || !record(response) || !record(response.Err) || response.Err.code !== 'storage') return response;
        // Another service channel can briefly own the derived index checkpoint.
        // These requests only read history; persistent failures retain their reply.
        await delay(25 * 2 ** attempt, undefined, { signal });
      }
    } catch (error) {
      this.assertReadable(signal);
      throw error;
    }
  }

  private assertReadable(signal: AbortSignal): void {
    if (this.closed || signal.aborted) throw new HostError("cancelled", "The history connection was closed.");
    if (!vscode.workspace.isTrusted) throw new HostError("workspace_untrusted", "Trust this workspace before reading history.");
  }

  async restart(): Promise<void> {
    if (this.closed) throw new HostError("cancelled", "The history connection was closed.");
    await this.client.shutdown();
    if (!this.closed) this.client = this.connect();
  }

  async shutdown(): Promise<void> { this.closed = true; await this.client.shutdown(); }
}
