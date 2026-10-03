import { isDeepStrictEqual } from 'node:util';
import { HostError, record } from '../host/protocol';
import { RecordReference, RecordSource, RepositoryBinding, parseRecord } from '../history/contracts';
import type { EditorRevision } from '../capture/editorCapture';

export interface ActivityRequest {
  binding: RepositoryBinding;
  source: RecordSource;
  selection: { Record: RecordReference } | { Editor: EditorRevision };
}
export type IndicatorKind = 'human' | 'ai' | 'other' | 'unknown' | 'exposure' | 'read';
export const KINDS: readonly IndicatorKind[] = ['human', 'ai', 'other', 'unknown', 'exposure', 'read'];
export interface TextRange { start: [number, number]; end: [number, number] }
export interface SourceRecord { record: RecordReference; original: boolean }
export interface Indicator { kind: IndicatorKind; range: TextRange | null; label: string; sources: SourceRecord[] }
export interface ActivityPreview {
  request: ActivityRequest;
  record: RecordReference;
  revision: string | null;
  text: string;
  indicators: Indicator[];
  issues: string[];
}

/** Validate native data before using it as coordinates or command arguments. */
export function parsePreview(value: unknown, request: ActivityRequest): ActivityPreview {
  const invalid = () => new HostError('invalid_response', 'The activity adapter returned invalid or unrelated revision details.');
  if (!record(value) || !isDeepStrictEqual(value.request, request) || typeof value.text !== 'string' ||
      Buffer.byteLength(value.text) > 8 * 1024 * 1024 || value.text.includes('\0') ||
      !(value.revision === null || typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision)) ||
      !Array.isArray(value.indicators) || value.indicators.length > 512 || !Array.isArray(value.issues) || value.issues.length > 128 ||
      !value.issues.every(issue => typeof issue === 'string' && issue.length <= 2048)) throw invalid();
  parseRecord(value.record);
  if ('Record' in request.selection && !isDeepStrictEqual(value.record, request.selection.Record)) throw invalid();
  const lines = value.text.split(/\r\n|\r|\n/);
  const position = (point: unknown): point is [number, number] => Array.isArray(point) && point.length === 2 &&
    point.every(unit => Number.isSafeInteger(unit) && unit >= 0) && point[0] < lines.length && point[1] <= lines[point[0]].length &&
    !(point[1] > 0 && /[\uD800-\uDBFF]/.test(lines[point[0]][point[1] - 1]) && /[\uDC00-\uDFFF]/.test(lines[point[0]][point[1]] ?? ''));
  for (const indicator of value.indicators) {
    if (!record(indicator) || !KINDS.includes(indicator.kind as IndicatorKind) || typeof indicator.label !== 'string' ||
        indicator.label.length > 2048 || !Array.isArray(indicator.sources) || indicator.sources.length > 34) throw invalid();
    if (indicator.range !== null) {
      const range = indicator.range;
      if (!record(range) || !position(range.start) || !position(range.end) ||
          range.start[0] > range.end[0] || range.start[0] === range.end[0] && range.start[1] > range.end[1]) throw invalid();
    }
    for (const source of indicator.sources) {
      if (!record(source) || typeof source.original !== 'boolean') throw invalid();
      parseRecord(source.record);
    }
  }
  return value as unknown as ActivityPreview;
}
