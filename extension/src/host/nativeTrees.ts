import * as vscode from "vscode";

/** Rust supplies all domain text, stable identities, status icons and action availability. */
export interface TreeRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly color?: string;
  readonly context: string;
  readonly actionable: boolean;
  readonly selected: boolean;
}

export interface TreeSnapshot { readonly id: string; readonly rows: readonly TreeRow[] }

/** Native list rendering, selection, accessibility and scrolling belong to VS Code. */
export class NativeTree implements vscode.TreeDataProvider<TreeRow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<TreeRow>;
  private rows: readonly TreeRow[] = [];
  private rendered = "";
  private query = "";

  constructor(readonly id: string, private readonly ready: () => Promise<void>) {
    this.view = vscode.window.createTreeView(id, { treeDataProvider: this, canSelectMany: false, showCollapseAll: false });
  }

  async getChildren(element?: TreeRow): Promise<TreeRow[]> {
    if (element) return [];
    await this.ready();
    const query = this.query.toLocaleLowerCase();
    return query ? this.rows.filter(row => `${row.label} ${row.description}`.toLocaleLowerCase().includes(query)) : [...this.rows];
  }

  getTreeItem(row: TreeRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.iconPath = new vscode.ThemeIcon(row.icon, row.color ? new vscode.ThemeColor(row.color) : undefined);
    item.contextValue = row.actionable ? row.context : "idle.notice";
    if (row.actionable) item.command = { command: "idle.sidebar.activate", title: "Open", arguments: [row.id] };
    return item;
  }

  update(rows: readonly TreeRow[]): void {
    const rendered = JSON.stringify(rows);
    if (rendered === this.rendered) return;
    this.rows = rows;
    this.rendered = rendered;
    this.view.message = undefined;
    this.changed.fire();
  }

  fail(message: string): void { this.view.message = message; }

  async filter(): Promise<void> {
    const query = await vscode.window.showInputBox({ title: `Filter ${this.view.title}`, value: this.query,
      prompt: "Match a name or description. Clear the text to show all items." });
    if (query !== undefined) this.setFilter(query.trim());
  }

  setFilter(query: string): void {
    this.query = query;
    this.view.description = query ? `Filter: ${query}` : undefined;
    void vscode.commands.executeCommand("setContext", `${this.id}.filtered`, Boolean(query));
    this.changed.fire();
  }

  dispose(): void { this.view.dispose(); this.changed.dispose(); }
}
