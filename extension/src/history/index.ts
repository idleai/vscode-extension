import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import { resolveFolder } from "../host/configuration";
import { HostDiagnostics } from "../host/diagnostics";
import { HostEffects } from "../host/effects";
import { HostError, record } from "../host/protocol";
import {
  HistoryBinding, HistoryPreview, HistoryProvider, HistoryRequest, RepositoryBinding,
  bindingKey, documentBytes, parseBinding, parseHistoryRequest, parseRecord,
} from "./contracts";
import { BYTE_SCHEME, TEXT_SCHEME, HEX_SCHEME, DocumentAddress, HexDocuments, TextDocuments, HistoryDocuments, documentUri, needsHex } from "./documents";
import { NativeHistoryProvider } from "./native";
import { openWorkingFile } from "./workingFile";
import { linkCancellation } from "./cancellation";
import { ActivityPreview, ActivityRequest, parsePreview } from "../provenance/contracts";

export type { HistoryBinding, HistoryProvider, HistoryRequest, HistoryPreview, RepositoryBinding } from "./contracts";
export { HistoryFailure } from "./contracts";

interface Connection {
  id: string;
  owner: symbol;
  binding: HistoryBinding;
  provider: HistoryProvider;
  abort: AbortController;
  ready?: Promise<void>;
}

/** Native editor actions live independently of any history webview. */
export class HistoryHost implements vscode.Disposable {
  private readonly connections = new Map<string, Connection>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly installed: vscode.Disposable[] = [];
  private readonly documents = new HistoryDocuments(address => this.read(address));
  private closed = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly extensionPath: string, effects: HostEffects, private readonly diagnostics: HostDiagnostics) {
    this.installed.push(
      this.documents,
      vscode.workspace.registerFileSystemProvider(BYTE_SCHEME, this.documents, { isReadonly: true, isCaseSensitive: true }),
      vscode.workspace.registerTextDocumentContentProvider(TEXT_SCHEME, new TextDocuments(this.documents)),
      vscode.workspace.registerTextDocumentContentProvider(HEX_SCHEME, new HexDocuments(this.documents)),
      effects.register("history.open", (params, context) => this.open(params, context.signal)),
      effects.register("history.openQuery", (params, context) => this.openQuery(params, context.signal)),
      effects.register("history.openWorkingFile", (params, context) => this.openWorking(params, context.signal)),
    );
    for (const target of ["Record", "Original", "File", "Diff"] as const) {
      const command = `idle.history.open${target}`;
      this.installed.push(vscode.commands.registerCommand(command, (params: unknown) =>
        this.diagnostics.command(command, () => this.open({ ...(record(params) ? params : {}), target }))));
    }
    this.installed.push(vscode.commands.registerCommand("idle.history.openWorkingFile", (params: unknown) =>
      this.diagnostics.command("Open working file", () => this.openWorking(params))));
  }

  /** Selection/coordination installs storage locations; webviews only send logical IDs. */
  connect(binding: HistoryBinding, provider?: HistoryProvider): vscode.Disposable {
    this.assertOpen();
    this.assertRoot(binding.root);
    const repository = parseBinding(binding.repository);
    if (typeof binding.chainDirectory !== "string") throw new HostError("invalid_binding", "History storage requires an explicit absolute directory.");
    for (const directory of [binding.chainDirectory, binding.retainedDirectory]) {
      if (directory !== undefined && (!directory || !path.isAbsolute(directory) || directory.includes("\0"))) {
        throw new HostError("invalid_binding", "History storage requires an explicit absolute directory.");
      }
    }
    const installed = { ...binding, repository };
    const key = bindingKey(repository);
    const old = this.connections.get(key);
    if (old) this.remove(key, old);
    const owner = Symbol();
    const connection = { id: randomUUID(), owner, binding: installed, provider: provider ?? new NativeHistoryProvider(this.extensionPath, installed), abort: new AbortController() };
    this.connections.set(key, connection);
    this.changed.fire();
    return new vscode.Disposable(() => {
      const current = this.connections.get(key);
      if (current?.owner === owner) this.remove(key, current);
    });
  }

  /** Renew document generations and native services while retaining the installed bindings. */
  async restart(): Promise<void> {
    this.assertOpen();
    const work: Promise<void>[] = [];
    for (const [key, connection] of this.connections) {
      const next: Connection = { ...connection, id: randomUUID(), abort: new AbortController() };
      const reset = async () => {
        this.assertCurrent(next);
        await next.provider.restart?.();
        this.assertCurrent(next);
      };
      next.ready = (connection.ready ?? Promise.resolve()).then(reset, reset);
      this.connections.set(key, next);
      connection.abort.abort();
      work.push(next.ready);
    }
    this.changed.fire();
    await Promise.all(work);
    this.changed.fire();
  }

  /** Editor projections share the native action binding and cancellation guards. */
  async activity(request: ActivityRequest, signal: AbortSignal, documentConnection?: string): Promise<ActivityPreview> {
    const connection = this.connection(parseBinding(request.binding));
    if (documentConnection !== undefined && documentConnection !== connection.id) {
      throw new HostError('unavailable', "This document's history binding has expired.");
    }
    if (!connection.provider.activity) throw new HostError('unavailable', 'Author and exposure reads are unavailable on this connection.');
    if (request.source === 'retained' && !connection.binding.retainedDirectory) throw new HostError('unavailable', 'A retained input source has not been bound.');
    this.assertCurrent(connection, signal);
    if (connection.ready) await connection.ready;
    this.assertCurrent(connection, signal);
    const linked = linkCancellation(connection.abort.signal, signal);
    try {
      const result = await connection.provider.activity(request, linked.signal);
      this.assertCurrent(connection, signal);
      return parsePreview(result, request);
    } finally { linked.dispose(); }
  }

  /** Shared history reads use only host-installed repository and storage bindings. */
  async query(params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!record(params) || !record(params.operation)) throw new HostError("invalid_request", "Expected a bound history query.");
    const connection = this.connection(parseBinding(params.binding));
    if (params.operation.chain !== connection.binding.repository.chain) throw new HostError("binding_mismatch", "The query belongs to a different chain.");
    if (record(params.operation.action) && record(params.operation.action.Open)) {
      return { Ok: await this.openQuery({ binding: params.binding, query: params.operation }, signal) };
    }
    if (!connection.provider.query) throw new HostError("unavailable", "History reads are unavailable on this connection.");
    this.assertCurrent(connection, signal);
    if (connection.ready) await connection.ready;
    this.assertCurrent(connection, signal);
    const linked = linkCancellation(connection.abort.signal, signal);
    try {
      const result = await connection.provider.query(params.operation, linked.signal);
      this.assertCurrent(connection, signal);
      return result;
    } finally { linked.dispose(); }
  }

  /** Adapter for app-core QueryAction::Open; the reducer receives Opened after editor success. */
  async openQuery(params: unknown, signal?: AbortSignal): Promise<"Opened"> {
    if (!record(params) || !record(params.query) || !record(params.query.action) || !record(params.query.action.Open)) {
      throw new HostError("invalid_request", "Expected an app-core native history query.");
    }
    const binding = parseBinding(params.binding);
    if (params.query.chain !== binding.chain) throw new HostError("binding_mismatch", "The query belongs to a different chain.");
    const open = params.query.action.Open;
    if (Object.keys(open).some(key => key !== "record" && key !== "target")) throw new HostError("invalid_request", "Invalid app-core native history action.");
    await this.open({ binding, source: "current", record: open.record, target: open.target }, signal);
    return "Opened";
  }

  async open(params: unknown, signal?: AbortSignal): Promise<{ uris: string[]; byteUris: string[] }> {
    const request = parseHistoryRequest(params);
    const connection = this.connection(request.binding);
    const preview = await this.resolve(connection, request, signal);
    const byteUris = preview.documents.map((document, part) => documentUri({ connection: connection.id, request, part }, document.name));
    // Both sides must use the same representation for a meaningful binary diff.
    const hex = preview.documents.some(document => needsHex(documentBytes(document.bytes)));
    const uris = preview.documents.map((document, part) => documentUri({ connection: connection.id, request, part }, document.name, hex ? "hex" : "text"));
    this.assertCurrent(connection, signal);
    if (request.target === "Diff") {
      await vscode.commands.executeCommand("vscode.diff", uris[0], uris[1], `${preview.documents[1].name} (recorded${hex ? " bytes, hex" : ""})`, { preview: true });
    } else {
      await vscode.commands.executeCommand("vscode.open", uris[0], { preview: true });
    }
    this.assertCurrent(connection, signal);
    return { uris: uris.map(uri => uri.toString()), byteUris: byteUris.map(uri => uri.toString()) };
  }

  async openWorking(params: unknown, signal?: AbortSignal): Promise<void> {
    if (!record(params)) throw new HostError("invalid_request", "Expected a bound working file.");
    const connection = this.connection(parseBinding(params.binding));
    await openWorkingFile(connection.binding.root, params, () => this.assertCurrent(connection, signal));
  }

  private async read(address: DocumentAddress): Promise<Uint8Array> {
    const connection = this.connection(address.request.binding);
    if (address.connection !== connection.id) throw new HostError("unavailable", "This document's history binding has expired.");
    const preview = await this.resolve(connection, address.request);
    const document = preview.documents[address.part];
    if (!document) throw new HostError("invalid_reference", "The requested document side does not exist.");
    return documentBytes(document.bytes);
  }

  private async resolve(connection: Connection, request: HistoryRequest, signal?: AbortSignal): Promise<HistoryPreview> {
    this.assertCurrent(connection, signal);
    if (connection.ready) {
      await connection.ready;
      this.assertCurrent(connection, signal);
    }
    if (request.source === "retained" && !connection.binding.retainedDirectory) {
      throw new HostError("unavailable", "A retained input source has not been bound.");
    }
    const cancellation = linkCancellation(connection.abort.signal, signal);
    let preview: HistoryPreview;
    try { preview = await connection.provider.resolve(request, cancellation.signal); }
    catch (error) { this.assertCurrent(connection, signal); throw error; }
    finally { cancellation.dispose(); }
    this.assertCurrent(connection, signal);
    if (!preview || !isDeepStrictEqual(preview.request, request) || !Array.isArray(preview.documents) ||
        preview.documents.length !== (request.target === "Diff" ? 2 : 1)) {
      throw new HostError("invalid_response", "The history adapter returned a different request or document count.");
    }
    for (const document of preview.documents) {
      if (!record(document) || typeof document.name !== "string" || document.name.length > 8192 || !("field" in document) || !("reference" in document)) {
        throw new HostError("invalid_response", "The history adapter returned an invalid document.");
      }
      parseRecord(document.record);
      documentBytes(document.bytes);
      if (request.target !== "Original" && !isDeepStrictEqual(document.record, request.record)) {
        throw new HostError("invalid_response", "The preview belongs to a different record.");
      }
    }
    return preview;
  }

  private connection(binding: RepositoryBinding): Connection {
    this.assertOpen();
    const connection = this.connections.get(bindingKey(binding));
    if (!connection) throw new HostError("unavailable", "This repository and chain have no installed history binding.");
    this.assertCurrent(connection);
    return connection;
  }

  private assertOpen(): void {
    if (this.closed) throw new HostError("host_closed", "The history host is shutting down.");
    if (!vscode.workspace.isTrusted) throw new HostError("workspace_untrusted", "Trust this workspace before reading history.");
  }

  private assertRoot(root: vscode.Uri): void {
    const folder = resolveFolder(root);
    if (root.query || root.fragment || folder.uri.scheme !== root.scheme || folder.uri.authority !== root.authority) {
      throw new HostError("invalid_binding", "The checkout must be on the bound workspace host.");
    }
  }

  private assertCurrent(connection: Connection, signal?: AbortSignal): void {
    this.assertOpen();
    if (signal?.aborted || connection.abort.signal.aborted || this.connections.get(bindingKey(connection.binding.repository)) !== connection) {
      throw new HostError("cancelled", "The history selection changed or its view closed.");
    }
    this.assertRoot(connection.binding.root);
  }

  disconnect(): void {
    for (const [key, connection] of this.connections) this.remove(key, connection);
  }

  private remove(key: string, connection: Connection): void {
    this.connections.delete(key);
    connection.abort.abort();
    this.changed.fire();
    const work = connection.provider.shutdown();
    this.retiring.add(work);
    void work.then(() => this.retiring.delete(work), error => this.diagnostics.failure("Closing history adapter", error));
  }

  async shutdown(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.disconnect();
      for (const disposable of this.installed) disposable.dispose();
      this.changed.dispose();
    }
    const results = await Promise.allSettled(this.retiring);
    if (results.some(result => result.status === "rejected")) throw new HostError("shutdown_failed", "A history adapter did not shut down.");
  }

  dispose(): void { void this.shutdown().catch(error => this.diagnostics.failure("History shutdown", error)); }
}
