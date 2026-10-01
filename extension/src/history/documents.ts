import * as vscode from "vscode";
import { HostError, record } from "../host/protocol";
import { HistoryRequest, parseHistoryRequest } from "./contracts";

export const BYTE_SCHEME = "idle-history";
export const TEXT_SCHEME = "idle-history-text";
export const HEX_SCHEME = "idle-history-hex";
export interface DocumentAddress { connection: string; request: HistoryRequest; part: number }

export function documentUri(address: DocumentAddress, name: string, preview?: "text" | "hex"): vscode.Uri {
  const basename = name.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, "_").slice(-180) || "record";
  const query = Buffer.from(JSON.stringify(address), "utf8").toString("base64url");
  const scheme = preview === "hex" ? HEX_SCHEME : preview === "text" ? TEXT_SCHEME : BYTE_SCHEME;
  return vscode.Uri.parse(`${scheme}:/${encodeURIComponent(basename)}${preview === "hex" ? ".hex" : ""}?${query}`);
}

export function documentAddress(uri: vscode.Uri): DocumentAddress {
  if (![BYTE_SCHEME, TEXT_SCHEME, HEX_SCHEME].includes(uri.scheme) || uri.authority || uri.fragment ||
      uri.query.length > 32768 || !/^[\w-]+$/.test(uri.query)) {
    throw new HostError("invalid_reference", "Invalid history document address.");
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(uri.query, "base64url").toString("utf8")); }
  catch { throw new HostError("invalid_reference", "Invalid history document address."); }
  if (!record(value) || typeof value.connection !== "string" || !Number.isInteger(value.part) ||
      (value.part !== 0 && value.part !== 1)) throw new HostError("invalid_reference", "Invalid history document address.");
  return { connection: value.connection, request: parseHistoryRequest(value.request), part: value.part };
}

/** Binary previews are lossless hexadecimal; no replacement-character decoding. */
export function needsHex(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); return false; }
  catch { return true; }
}

export function hexText(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${Array.from(row, byte => byte.toString(16).padStart(2, "0")).join(" ")}`);
  }
  return lines.join("\n");
}

/** Stateless byte provider: closed/unknown documents fail; empty files remain valid. */
export class HistoryDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  constructor(private readonly read: (address: DocumentAddress) => Promise<Uint8Array>) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const bytes = await this.readFile(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.length, permissions: vscode.FilePermission.Readonly };
  }
  readFile(uri: vscode.Uri): Promise<Uint8Array> { return this.read(documentAddress(uri)); }
  readDirectory(): [string, vscode.FileType][] { throw vscode.FileSystemError.NoPermissions("History documents are read-only."); }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions("History documents are read-only."); }
  writeFile(): void { throw vscode.FileSystemError.NoPermissions("History documents are read-only."); }
  delete(): void { throw vscode.FileSystemError.NoPermissions("History documents are read-only."); }
  rename(): void { throw vscode.FileSystemError.NoPermissions("History documents are read-only."); }
  dispose(): void { this.changed.dispose(); }
}

/** Human-readable view of all binary bytes; the companion byte URI stays exact. */
export class HexDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly documents: HistoryDocuments) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return hexText(await this.documents.readFile(uri));
  }
}

/** Decode independently of files.encoding and retain a recorded UTF-8 BOM. */
export class TextDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly documents: HistoryDocuments) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const bytes = await this.documents.readFile(uri);
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new HostError("binary_content", "Use the hexadecimal preview for these recorded bytes."); }
  }
}
