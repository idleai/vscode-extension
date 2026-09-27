import * as vscode from "vscode";
import { HostError, publicError } from "./protocol";

/** Platform status only; domain counts/status come from app-core. */
export class HostDiagnostics implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("Idle");
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);

  constructor() {
    this.status.name = "Idle host";
    this.status.text = "$(history) Idle";
    this.status.tooltip = "Open Idle workspace";
    this.status.command = "idle.open";
    this.status.show();
  }

  show(): void { this.output.show(true); }
  append(message: string): void { this.output.appendLine(message); }

  failure(operation: string, error: unknown): void {
    const failure = publicError(error);
    this.append(`${operation}: ${failure.code}`);
  }

  async notify(level: "info" | "warning" | "error", message: string): Promise<void> {
    if (level === "info") await vscode.window.showInformationMessage(message);
    else if (level === "warning") await vscode.window.showWarningMessage(message);
    else await vscode.window.showErrorMessage(message);
  }

  async command<T>(operation: string, action: () => T | PromiseLike<T>): Promise<T | undefined> {
    try { return await action(); }
    catch (error) {
      if (error instanceof HostError && error.code === "cancelled") return undefined;
      this.failure(operation, error);
      await this.notify("error", `Idle: ${publicError(error).message}`);
      return undefined;
    }
  }

  dispose(): void { this.status.dispose(); this.output.dispose(); }
}
