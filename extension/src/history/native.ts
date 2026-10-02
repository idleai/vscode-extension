import { isDeepStrictEqual } from "node:util";
import { StdioClient } from "../host/processes";
import { HostError, record } from "../host/protocol";
import { resolveNativePath } from "../host/configuration";
import * as vscode from "vscode";
import { HistoryBinding, HistoryFailure, HistoryPreview, HistoryProvider, HistoryRequest, parseRecord } from "./contracts";

/** Lazy packaged engine process; every request uses the installed storage binding. */
export class NativeHistoryProvider implements HistoryProvider {
  private client = new StdioClient();
  private closed = false;

  constructor(private readonly extensionPath: string, private readonly binding: HistoryBinding) {}

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

  private async request(request: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed || signal.aborted) throw new HostError("cancelled", "The history connection was closed.");
    if (!vscode.workspace.isTrusted) throw new HostError("workspace_untrusted", "Trust this workspace before reading history.");
    const configured = vscode.workspace.getConfiguration("idle", this.binding.root).get<string>("native.historyPath", "");
    const binary = resolveNativePath(configured, this.extensionPath, "idle-history-service");
    this.client.ensureStarted(binary, { cwd: this.binding.root.fsPath, args: [JSON.stringify({
      repository: this.binding.repository,
      chain_directory: this.binding.chainDirectory,
      retained_directory: this.binding.retainedDirectory ?? null,
    })] });
    return this.client.request(request, { signal });
  }

  async restart(): Promise<void> {
    if (this.closed) throw new HostError("cancelled", "The history connection was closed.");
    await this.client.shutdown();
    if (!this.closed) this.client = new StdioClient();
  }

  async shutdown(): Promise<void> { this.closed = true; await this.client.shutdown(); }
}
