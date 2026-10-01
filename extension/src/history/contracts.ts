import type * as vscode from "vscode";
import { HostError, PublicHostError, record } from "../host/protocol";

/** JSON contracts shared with idle-vscode-native::history and app-core. */
export interface RepositoryBinding { workspace_id: string; repository_id: string; chain: string }
export interface RecordReference { operation: string; hash: string }
export type RecordSource = "current" | "retained";
export type HistoryTarget = "Record" | "Original" | "File" | "Diff" |
  { Content: { field: unknown; reference: unknown } };
export interface HistoryRequest {
  binding: RepositoryBinding;
  source: RecordSource;
  record: RecordReference;
  target: HistoryTarget;
}
export interface HistoryDocument {
  name: string;
  record: RecordReference;
  field: unknown;
  reference: unknown;
  bytes: string | number[];
}
export interface HistoryPreview { request: HistoryRequest; documents: HistoryDocument[] }
export interface HistoryBinding {
  /** Exact checkout on the file-owning extension host; never inferred from a remote URL. */
  root: vscode.Uri;
  repository: RepositoryBinding;
  /** Absolute directories supplied by trusted selection/coordination code. */
  chainDirectory: string;
  retainedDirectory?: string;
}
export interface HistoryProvider {
  /** Resolve full records and fields through engine APIs, preserving explicit gaps. */
  resolve(request: HistoryRequest, signal: AbortSignal): Promise<HistoryPreview>;
  /** Reset owned native services without releasing the binding; reads wait for completion. */
  restart?(): Promise<void>;
  shutdown(): Promise<void>;
}

export class HistoryFailure extends HostError {
  readonly candidates: readonly RecordReference[];

  constructor(code: string, message: string, candidates: readonly RecordReference[] = []) {
    super(code, message);
    this.candidates = Object.freeze(candidates.map(candidate => Object.freeze(parseRecord(candidate))));
  }

  override toPublic(): PublicHostError {
    return { ...super.toPublic(), details: { candidates: this.candidates } };
  }
}

export function bindingKey(binding: RepositoryBinding): string {
  return JSON.stringify([binding.workspace_id, binding.repository_id, binding.chain]);
}

export function parseBinding(value: unknown): RepositoryBinding {
  if (!record(value) || Object.keys(value).some(key => !["workspace_id", "repository_id", "chain"].includes(key)) ||
      ![value.workspace_id, value.repository_id, value.chain].every(item =>
        typeof item === "string" && item.trim().length > 0 && item.length <= 8192 && !item.includes("\0"))) {
    throw new HostError("invalid_request", "An explicit workspace, repository and chain binding is required.");
  }
  return { workspace_id: value.workspace_id as string, repository_id: value.repository_id as string, chain: value.chain as string };
}

export function parseRecord(value: unknown): RecordReference {
  if (!record(value) || ![value.operation, value.hash].every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))) {
    throw new HostError("invalid_reference", "A complete lowercase operation ID and record digest are required.");
  }
  return { operation: value.operation as string, hash: value.hash as string };
}

export function parseHistoryRequest(value: unknown): HistoryRequest {
  if (!record(value) || Object.keys(value).some(key => !["binding", "source", "record", "target"].includes(key))) {
    throw new HostError("invalid_request", "Invalid history action.");
  }
  const source = value.source ?? "current";
  if (source !== "current" && source !== "retained") throw new HostError("invalid_request", "Invalid history source.");
  const target = value.target;
  if (!["Record", "Original", "File", "Diff"].includes(target as string) &&
      !(record(target) && Object.keys(target).length === 1 && record(target.Content) &&
        Object.keys(target.Content).length === 2 && "field" in target.Content && "reference" in target.Content)) {
    throw new HostError("invalid_request", "Invalid history target.");
  }
  return JSON.parse(JSON.stringify({ binding: parseBinding(value.binding), source, record: parseRecord(value.record), target })) as HistoryRequest;
}

/** Decode the engine's shared text/binary codec without replacement characters. */
export function documentBytes(value: unknown): Buffer {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.toString("utf8") === value) return bytes;
  } else if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Buffer.from(value);
  }
  throw new HostError("invalid_response", "The history adapter returned invalid content bytes.");
}
