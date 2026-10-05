import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { HostError } from "./protocol";

export interface FolderConfiguration {
  readonly folder: vscode.WorkspaceFolder;
  readonly cwd: string;
  readonly chainDirectory: string;
}

/** Explicit folder resolution; never guess the first root in a multi-root window. */
export function resolveFolder(uri: vscode.Uri): vscode.WorkspaceFolder {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) throw new HostError("folder_unavailable", "The resource is outside the open workspace.");
  const nativeScheme = folder.uri.scheme === "file" ||
    (folder.uri.scheme === "vscode-remote" && Boolean(vscode.env.remoteName));
  if (!nativeScheme) throw new HostError("unsupported_filesystem", "Native adapters require a workspace on this extension host.");
  return folder;
}

/** Resolve only configured or packaged artifacts; do not execute workspace build outputs implicitly. */
export function resolveNativePath(
  configured: string, extensionPath: string, binary: string,
  platform = process.platform, arch = process.arch, exists = existsSync,
): string {
  const candidate = configured || path.join(extensionPath, "bin", `${platform}-${arch}`, `${binary}${platform === "win32" ? ".exe" : ""}`);
  if (!path.isAbsolute(candidate)) throw new HostError("invalid_configuration", "Configure an absolute native executable path on the workspace host.");
  if (!exists(candidate)) throw new HostError("native_unavailable", "The native adapter is not installed. Configure its path on the workspace host or install a package containing it.");
  return candidate;
}

export class HostConfiguration {
  constructor(private readonly extensionPath: string) {}

  assertTrusted(): void {
    if (!vscode.workspace.isTrusted) throw new HostError("workspace_untrusted", "Trust this workspace before starting a native adapter.");
  }

  forResource(uri: vscode.Uri): FolderConfiguration {
    this.assertTrusted();
    const folder = resolveFolder(uri);
    const config = vscode.workspace.getConfiguration("idle", folder.uri);
    const chain = config.get<string>("chainDirectory", ".editchain");
    if (!chain || chain.includes("\0")) throw new HostError("invalid_configuration", "Configure a nonempty chain directory.");
    // Each folder owns its service channels and chain binding. Resource paths never
    // resolve against the UI machine or another folder's working directory.
    return {
      folder, cwd: folder.uri.fsPath,
      chainDirectory: path.resolve(folder.uri.fsPath, chain),
    };
  }

  snapshot(): unknown {
    return {
      trusted: vscode.workspace.isTrusted,
      remoteName: vscode.env.remoteName ?? null,
      folders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({ uri: folder.uri.toString(), name: folder.name })),
    };
  }

  nativeBinary(): string {
    this.assertTrusted();
    return resolveNativePath(vscode.workspace.getConfiguration('idle').get('native.hostPath', ''), this.extensionPath, 'idle-host');
  }
}
