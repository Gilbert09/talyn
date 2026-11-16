import { describeTool, type ToolBlock } from '@talyn/shared';

import { inlineText, parseMarkdown, type MdBlock } from '../../lib/markdown';
import { preview, readableOutput, toolLine } from './toolFormat';
import type { TranscriptRow } from './transcript';

/** One occurrence of the query. `rowIndex` is the row's place in the rows given to `findMatches`. */
export interface FindMatch { rowKey: string; rowIndex: number; occurrence: number }
/** The match a person selected, kept by row key so new rows do not move it. */
export interface FindSelection { rowKey: string; occurrence: number }

export const BOX_REFUSALS: Record<string, string> = {
  usage_exhausted: 'Out of hours', box_limit_reached: 'All your boxes are busy', size_requires_pro: 'This size needs Pro',
};
/** Lines of a failed tool's output that show before the row opens. */
export const ERROR_PREVIEW_LINES = 3;
export const ERROR_PREVIEW_CHARS = 1200;

type SystemRow = Extract<TranscriptRow, { kind: 'system' }>;
/** The line a system row shows. `SystemRow` draws this text. */
export function systemRowText(row: SystemRow): string {
  if (row.subtype === 'talyn_interruption') return 'Interrupted';
  if (row.subtype && BOX_REFUSALS[row.subtype]) return `${BOX_REFUSALS[row.subtype]}. ${row.text}`;
  if (row.subtype === 'talyn_message') return row.text.length > 280 ? `${row.text.slice(0, 280)}…` : row.text;
  return row.text;
}

type PermissionRow = Extract<TranscriptRow, { kind: 'permission' }>;
/** The title of a permission row. `PermissionRow` draws this text. */
export function permissionTitle(row: PermissionRow): string {
  if (row.status === 'pending') return `${row.toolName} is waiting for approval`;
  if (row.status === 'denied') return `Denied ${row.toolName}`;
  if (row.status === 'auto_allowed') return `Allowed ${row.toolName} automatically`;
  return `Allowed ${row.toolName}${row.persist ? ' for this session' : ''}`;
}

function blockText(blocks: MdBlock[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === 'paragraph' || block.type === 'heading') lines.push(inlineText(block.children));
    else if (block.type === 'code') lines.push(block.text);
    else if (block.type === 'blockquote') lines.push(...blockText(block.children));
    else if (block.type === 'list') for (const item of block.items) lines.push(...blockText(item.children));
    else if (block.type === 'table') for (const row of [block.header, ...block.rows]) lines.push(...row.map(inlineText));
  }
  return lines;
}
/** The words a markdown message shows, without its syntax. Each block is on its own line. */
export function markdownText(text: string): string {
  return blockText(parseMarkdown(text).blocks).join('\n');
}

/** The collapsed line of a tool call, and its error preview, which shows before the row opens. */
function toolText(tool: ToolBlock): string {
  const line = toolLine(tool.name, tool.input);
  const parts = [line.label, line.detail ?? ''];
  if (tool.stopped) parts.push('stopped');
  let text = parts.filter(Boolean).join(' ');
  if (tool.isError) {
    const shown = preview(readableOutput(tool.output).text, ERROR_PREVIEW_LINES, ERROR_PREVIEW_CHARS).text;
    if (shown) text += `\nError\n${shown}`;
  }
  return text;
}

function computeText(row: TranscriptRow): string {
  switch (row.kind) {
    case 'user': return markdownText(row.text);
    case 'text': return markdownText(row.text);
    case 'thinking': return row.text.split('\n').find((line) => line.trim())?.trim() ?? 'Thinking';
    case 'tool': return toolText(row.tool);
    case 'tool_group': {
      const { group } = row;
      const summary = `${group.summary}${group.failedCount > 0 ? ` · ${group.failedCount} failed` : ''}`;
      // A group whose last call failed opens by itself, so its calls show.
      if (!group.lastFailed || group.running) return summary;
      return [summary, ...group.children.map((child) => child.kind === 'thinking' ? 'Thought' : toolText(child))].join('\n');
    }
    case 'permission': {
      const detail = describeTool(row.toolName, row.toolInput).detail;
      return detail ? `${permissionTitle(row)}\n${detail}` : permissionTitle(row);
    }
    case 'system': return systemRowText(row);
    case 'failed': return `Turn failed. ${row.text}`;
    case 'stopped': return 'Stopped';
    case 'queued': return `${row.text}\n${row.fromTalyn ? 'From Talyn' : 'Queued'}`;
    case 'plan': return `Plan${row.state === 'approved' ? ' Approved' : ''}\n${markdownText(row.plan)}`;
    case 'broken': return 'Part of this conversation could not be shown.';
  }
}

// Rows keep their object while they draw the same, so the text is kept per row object.
const texts = new WeakMap<TranscriptRow, string>();
/** The text a person can see in a row, before they open anything. Hidden tool output and thinking are not included. */
export function rowSearchText(row: TranscriptRow): string {
  let text = texts.get(row);
  if (text === undefined) {
    try { text = computeText(row) ?? ''; } catch { text = ''; }
    texts.set(row, text);
  }
  return text;
}

/** The query as it is matched: trimmed and lower case. Empty means no search. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Start offsets of each occurrence of `needle` in `text`, case-insensitive. Occurrences do not overlap. */
export function occurrences(text: string, needle: string): number[] {
  const query = normalizeQuery(needle);
  if (!query) return [];
  const haystack = text.toLowerCase();
  const found: number[] = [];
  for (let at = haystack.indexOf(query); at !== -1; at = haystack.indexOf(query, at + query.length)) found.push(at);
  return found;
}

/** Every occurrence of the query, in the order of `rows`. Give rows oldest first, so the matches are in document order. */
export function findMatches(rows: readonly TranscriptRow[], query: string): FindMatch[] {
  if (!normalizeQuery(query)) return [];
  const matches: FindMatch[] = [];
  rows.forEach((row, rowIndex) => {
    const count = occurrences(rowSearchText(row), query).length;
    for (let occurrence = 0; occurrence < count; occurrence++) matches.push({ rowKey: row.key, rowIndex, occurrence });
  });
  return matches;
}

/**
 * The index of the selected match after the rows change. The same occurrence in the same row first,
 * then the last occurrence left in that row. With no selection, or when its row has no match now, the
 * newest match. -1 when there are no matches.
 */
export function selectedIndex(matches: readonly FindMatch[], selected: FindSelection | null): number {
  if (!matches.length) return -1;
  if (selected) {
    let inRow = -1;
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      if (match.rowKey !== selected.rowKey) continue;
      if (match.occurrence === selected.occurrence) return index;
      inRow = index;
    }
    if (inRow !== -1) return inRow;
  }
  return matches.length - 1;
}

/** The next (+1) or previous (-1) match, wrapping at each end. */
export function stepIndex(index: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0) return step === 1 ? 0 : count - 1;
  return (index + step + count) % count;
}

/** "3 of 12", "No results", or empty while there is no query. */
export function matchCountLabel(index: number, count: number, query: string): string {
  if (!normalizeQuery(query)) return '';
  if (!count) return 'No results';
  return `${index + 1} of ${count}`;
}

/** `text` cut into parts, with each occurrence of the query marked. */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = normalizeQuery(query);
  const starts = occurrences(text, needle);
  if (!starts.length) return [{ text, match: false }];
  const parts: Array<{ text: string; match: boolean }> = [];
  let at = 0;
  for (const start of starts) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, start + needle.length), match: true });
    at = start + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
