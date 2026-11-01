import * as vscode from "vscode";
import { HostError, record } from "../host/protocol";
import { RepositoryBinding, parseBinding } from "./contracts";
import { CommitFileTarget, parseCommitFile } from "./timelineTarget";

export const GIT_FILE_SCHEME = "idle-history-git-file";
export interface GitFileAddress {
  connection: string; binding: RepositoryBinding; change: CommitFileTarget; side: "before" | "after" | "metadata";
}
export interface GitFileText { before: string; after: string }

export function gitFileUri(address: GitFileAddress): vscode.Uri {
  const path = address.side === "before" ? address.change.old_path ?? address.change.path : address.change.path;
  const name = address.side === "metadata" ? "change.json" : path.split("/").at(-1) ?? "file";
  const query = Buffer.from(JSON.stringify(address), "utf8").toString("base64url");
  return vscode.Uri.parse(`${GIT_FILE_SCHEME}:/${address.side}/${encodeURIComponent(name)}?${query}`);
}

/** Each immutable side stays bound to the connection that advertised the change. */
export class GitFileDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly read: (address: GitFileAddress) => Promise<string>) {}
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme !== GIT_FILE_SCHEME || uri.authority || uri.fragment || uri.query.length > 32768 || !/^[\w-]+$/.test(uri.query)) {
      throw new HostError("invalid_reference", "Invalid Git file document address.");
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.from(uri.query, "base64url").toString("utf8")); }
    catch { throw new HostError("invalid_reference", "Invalid Git file document address."); }
    if (!record(value) || Object.keys(value).length !== 4 || typeof value.connection !== "string"
      || !["before", "after", "metadata"].includes(String(value.side))) {
      throw new HostError("invalid_reference", "Invalid Git file document address.");
    }
    return this.read({ connection: value.connection, binding: parseBinding(value.binding),
      change: parseCommitFile(value.change), side: value.side as GitFileAddress["side"] });
  }
}
