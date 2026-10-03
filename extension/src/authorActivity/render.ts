import * as vscode from 'vscode';
import { HistoryRequest } from '../history/contracts';
import { ActivityPreview, ActivityRequest, Indicator, IndicatorKind, KINDS } from './contracts';

const COLORS: Record<IndicatorKind, string> = {
  human: 'charts.blue', ai: 'charts.purple', other: 'charts.orange', unknown: 'editorWarning.foreground',
  exposure: 'charts.yellow', read: 'charts.green',
};
const HISTORY_COMMANDS = ['idle.history.openRecord', 'idle.history.openOriginal'];

/** Native styles and trusted links are owned here; recorded labels stay plain text. */
export class ActivityRenderer implements vscode.Disposable {
  private readonly types = new Map(KINDS.map(kind => [kind, vscode.window.createTextEditorDecorationType({
    borderWidth: '0 0 1px 0', borderStyle: kind === 'unknown' ? 'dashed' : 'solid',
    borderColor: new vscode.ThemeColor(COLORS[kind]), rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })]));
  private readonly header = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 1.5em' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.header, []);
    for (const type of this.types.values()) editor.setDecorations(type, []);
  }

  status(editor: vscode.TextEditor, message: string): void {
    this.clear(editor);
    const hover = markdown();
    hover.appendText(message);
    const end = editor.document.lineAt(0).range.end;
    editor.setDecorations(this.header, [{ range: new vscode.Range(end, end), hoverMessage: hover,
      renderOptions: { after: { contentText: 'Idle · observations unavailable' } } }]);
  }

  show(editor: vscode.TextEditor, preview: ActivityPreview): void {
    for (const [kind, type] of this.types) {
      editor.setDecorations(type, preview.indicators.filter(indicator => indicator.kind === kind && indicator.range)
        .map(indicator => ({ range: nativeRange(indicator), hoverMessage: hover(preview.request, indicator) })));
    }
    const summary = markdown();
    summary.appendText(`Recorded revision: ${preview.revision ?? 'identity unavailable'}.\n\n`);
    for (const indicator of preview.indicators.filter(indicator => !indicator.range)) {
      summary.appendText(indicator.label + '\n\n');
      links(summary, preview.request, indicator);
    }
    for (const issue of preview.issues) summary.appendText(issue + '\n\n');
    summary.appendText('Indicators describe recorded activity on this revision. Visibility and read intervals do not establish review or comprehension.');
    const args = encodeURIComponent(JSON.stringify([editor.document.uri.toString()]));
    summary.appendMarkdown(`\n\n[Show all source records](command:idle.activity.showSources?${args})`);
    summary.isTrusted = { enabledCommands: [...HISTORY_COMMANDS, 'idle.activity.showSources'] };
    editor.setDecorations(this.header, [{ range: headerRange(preview.text), hoverMessage: summary,
      renderOptions: { after: { contentText: summaryText(preview) } } }]);
  }

  dispose(): void { this.header.dispose(); for (const type of this.types.values()) type.dispose(); }
}

function headerRange(text: string): vscode.Range {
  const newline = text.search(/[\r\n]/);
  const column = newline < 0 ? text.length : newline;
  return new vscode.Range(0, column, 0, column);
}

function summaryText(preview: ActivityPreview): string {
  const kinds = new Set(preview.indicators.map(indicator => indicator.kind));
  const author = kinds.has('human') ? 'human input/author' : kinds.has('ai') ? 'AI author'
    : kinds.has('other') ? 'tool/system author' : 'author unknown';
  const exposure = kinds.has('read') ? 'read interval recorded' : kinds.has('exposure') ? 'visibility recorded' : 'exposure unknown';
  return `Idle · ${author} · ${exposure}${preview.issues.length ? ' · incomplete observations' : ''}`;
}

function nativeRange(indicator: Indicator): vscode.Range {
  const range = indicator.range!;
  return new vscode.Range(...range.start, ...range.end);
}

function markdown(): vscode.MarkdownString {
  const value = new vscode.MarkdownString();
  value.isTrusted = { enabledCommands: HISTORY_COMMANDS };
  value.supportHtml = false;
  return value;
}

function hover(request: ActivityRequest, indicator: Indicator): vscode.MarkdownString {
  const value = markdown();
  value.appendText(indicator.label + '\n\n');
  if (indicator.kind === 'read' || indicator.kind === 'exposure') value.appendText('Observed on this exact revision; review and comprehension are unknown.\n\n');
  links(value, request, indicator);
  return value;
}

function links(value: vscode.MarkdownString, request: ActivityRequest, indicator: Indicator): void {
  for (const source of indicator.sources.slice(0, 6)) {
    for (const target of source.original ? ['Record', 'Original'] as const : ['Record'] as const) {
      const action: HistoryRequest = { binding: request.binding, source: request.source, record: source.record, target };
      const args = encodeURIComponent(JSON.stringify([action]));
      value.appendMarkdown(`[${target} ${source.record.operation.slice(0, 8)}](command:idle.history.open${target}?${args})  `);
    }
    value.appendMarkdown('\n\n');
  }
}
