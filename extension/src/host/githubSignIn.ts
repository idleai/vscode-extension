import * as vscode from "vscode";
import { HostError } from "./protocol";

/** The built-in provider owns device codes, tokens and browser interaction. */
export async function prepareGitHubSignIn(assertActive: () => void): Promise<void> {
  if (vscode.env.remoteName !== "ssh-remote") return;
  const configuration = vscode.workspace.getConfiguration("github-authentication");
  const key = "preferDeviceCodeFlow";
  // Older GitHub providers choose their own available fallback flows.
  if (!configuration.inspect(key) || configuration.get<boolean>(key)) return;
  const choice = await vscode.window.showQuickPick([
    {
      label: "Use device code",
      description: "Recommended for Remote SSH",
      detail: "Enter a code in your browser without returning through a redirect. Saves this GitHub sign-in preference for VS Code.",
      device: true,
    },
    {
      label: "Use browser redirect",
      detail: "Continue with VS Code's current GitHub sign-in flow.",
      device: false,
    },
  ], { title: "GitHub sign-in", placeHolder: "Choose how to complete GitHub sign-in for this remote window", ignoreFocusOut: true });
  assertActive();
  if (!choice) throw new HostError("authentication_cancelled", "GitHub sign-in was cancelled. Connect again to retry.");
  if (choice.device) {
    try { await configuration.update(key, true, vscode.ConfigurationTarget.Global); }
    catch {
      throw new HostError("authentication_configuration_failed", "Enable GitHub Authentication: Prefer Device Code Flow in VS Code settings, then connect again.");
    }
  }
}
