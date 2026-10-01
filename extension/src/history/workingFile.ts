import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { HostError, record } from "../host/protocol";

/** Only an explicit working-copy action may read the live checkout. */
export async function openWorkingFile(root: vscode.Uri, params: Record<string, unknown>, current: () => void): Promise<void> {
  const relative = params.path;
  if (typeof relative !== "string" || !relative || relative.length > 8192 || /[\\:\x00-\x1f]/.test(relative) ||
      relative.split("/").some(part => !part || part === "." || part === "..")) {
    throw new HostError("invalid_request", "Use a repository-relative file path without traversal.");
  }
  if (params.revision !== undefined && params.revision !== null) {
    throw new HostError("invalid_request", "Historical files require a complete recorded-content reference.");
  }
  const [base, destination] = await Promise.all([realpath(root.fsPath), realpath(path.join(root.fsPath, relative))]);
  current();
  const suffix = path.relative(base, destination);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) {
    throw new HostError("denied", "The file resolves outside the bound checkout.");
  }
  const uri = vscode.Uri.joinPath(root, relative);
  const document = await vscode.workspace.openTextDocument(uri);
  current();
  let selection: vscode.Range | undefined;
  if (params.position !== undefined && params.position !== null) {
    const position = params.position;
    if (!record(position) || !Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.column) ||
        (position.line as number) < 1 || (position.line as number) > document.lineCount || (position.column as number) < 1) {
      throw new HostError("invalid_request", "Invalid one-based text position.");
    }
    const line = (position.line as number) - 1;
    const scalars = Array.from(document.lineAt(line).text);
    if ((position.column as number) > scalars.length + 1) throw new HostError("invalid_request", "Text position is outside the file.");
    const column = scalars.slice(0, (position.column as number) - 1).join("").length;
    selection = new vscode.Range(line, column, line, column);
  }
  await vscode.window.showTextDocument(document, { preview: true, selection });
}
