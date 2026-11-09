import { describeTool, formatToolOutput } from '@talyn/shared';

const sentence = (words: string) => words ? words.charAt(0).toUpperCase() + words.slice(1) : words;

/** `mcp__linear__create_issue` is "Linear · Create issue". The server prefix inside the tool name is dropped. */
export function humanToolName(name: string): string {
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!mcp) return name;
  const server = mcp[1].replace(/[_-]+/g, ' ').trim();
  let tool = mcp[2];
  const prefix = `${mcp[1]}_`;
  if (tool.toLowerCase().startsWith(prefix.toLowerCase()) && tool.length > prefix.length) tool = tool.slice(prefix.length);
  return `${sentence(server)} · ${sentence(tool.replace(/[_-]+/g, ' ').trim().toLowerCase())}`;
}

/** The repository-relative part of a sandbox path, like web. */
export function shortenPath(path: string): string {
  const work = /^\/work\/[^/]+\/(.+)$/.exec(path);
  if (work) return work[1];
  for (const marker of ['/packages/', '/apps/']) {
    const index = path.indexOf(marker);
    if (index !== -1) return path.slice(index + 1);
  }
  const src = path.indexOf('/src/');
  if (src !== -1) {
    const before = path.lastIndexOf('/', src - 1);
    if (before !== -1) return path.slice(before + 1);
  }
  if (path.startsWith('/Users/') || path.startsWith('/home/')) {
    const after = path.indexOf('/', path.indexOf('/', 1) + 1);
    if (after !== -1) return `~${path.slice(after)}`;
  }
  return path;
}

export interface ToolLine { label: string; detail: string; isCommand: boolean }
/** One line for a tool call: a short verb and what it acted on. */
export function toolLine(name: string, input: unknown): ToolLine {
  const described = describeTool(name, input);
  const label = described.label === name ? humanToolName(name) : described.label;
  return { label, detail: described.isCommand ? described.detail : shortenPath(described.detail), isCommand: described.isCommand };
}

/** `\n`, `\t` and `\\` written as escapes become the characters they stand for. Other escapes stay. */
export function unescapeText(text: string): string {
  return text.replace(/\\(n|t|\\)/g, (_, char: string) => char === 'n' ? '\n' : char === 't' ? '\t' : '\\');
}

export interface ReadableOutput { text: string; lines: number; chars: number; summary: string; diff: boolean }
/** Tool output for reading: JSON indented, escaped newlines real, with its size. */
export function readableOutput(output: unknown): ReadableOutput {
  const formatted = formatToolOutput(output);
  const text = formatted.isJson || /\\n/.test(formatted.text) && !formatted.text.includes('\n') ? unescapeText(formatted.text) : formatted.text;
  const lines = text ? text.split('\n').length : 0;
  const summary = formatted.isJson || text === formatted.text || lines < 2 ? formatted.summary : `${lines} lines`;
  return { text, lines, chars: text.length, summary, diff: looksLikeDiff(text) };
}

export type DiffTone = 'add' | 'del' | 'hunk' | null;
export function diffTone(line: string): DiffTone {
  if (line.startsWith('+++') || line.startsWith('---')) return null;
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return null;
}
/** A unified diff, by its markers: a hunk header or a git diff header, plus changed lines. */
export function looksLikeDiff(text: string): boolean {
  if (!/^(@@ |diff --git )/m.test(text)) return false;
  return /^[+-](?![+-]{2} )/m.test(text);
}

/** At most `maxLines` lines and `maxChars` characters. `hidden` is true when something was cut. */
export function preview(text: string, maxLines: number, maxChars: number): { text: string; hidden: boolean } {
  let shown = text.length > maxChars ? text.slice(0, maxChars) : text;
  const lines = shown.split('\n');
  if (lines.length > maxLines) shown = lines.slice(0, maxLines).join('\n');
  return { text: shown, hidden: shown.length < text.length };
}
