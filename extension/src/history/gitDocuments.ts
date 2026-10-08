import * as vscode from "vscode";
import { HostError, record } from "../host/protocol";
import { RepositoryBinding, parseBinding } from "./contracts";
import { CommitTarget, parseTimelineTarget } from "./timelineTarget";

export const GIT_SCHEME = "idle-history-git";
export interface GitAddress { connection: string; binding: RepositoryBinding; commit: CommitTarget }

export function gitUri(address: GitAddress): vscode.Uri {
  const query = Buffer.from(JSON.stringify(address), "utf8").toString("base64url");
  return vscode.Uri.parse(`${GIT_SCHEME}:/${address.commit.oid}.diff?${query}`);
}

/** Commit documents are resolved again against the connection that opened them. */
export class GitDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly read: (address: GitAddress) => Promise<string>) {}
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme !== GIT_SCHEME || uri.authority || uri.fragment || uri.query.length > 32768 || !/^[\w-]+$/.test(uri.query)) {
      throw new HostError("invalid_reference", "Invalid commit document address.");
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.from(uri.query, "base64url").toString("utf8")); }
    catch { throw new HostError("invalid_reference", "Invalid commit document address."); }
    if (!record(value) || typeof value.connection !== "string") throw new HostError("invalid_reference", "Invalid commit document address.");
    const target = parseTimelineTarget({ Commit: value.commit });
    if (!("Commit" in target)) throw new HostError("invalid_reference", "Invalid commit document destination.");
    return this.read({ connection: value.connection, binding: parseBinding(value.binding), commit: target.Commit });
  }
}
