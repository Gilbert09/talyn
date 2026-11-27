/**
 * Markdown highlighting for the message composer.
 *
 * The composer stays a plain text field: the agent gets the Markdown source.
 * These tokens only style that source while the person types (web and desktop
 * paint them behind a transparent textarea, mobile nests them in its
 * TextInput). The markers stay in the text, so the lines joined with '\n'
 * always give back the input exactly.
 */

/** How a run of text looks. `marker` is Markdown syntax: `**`, `>`, `-`, a backtick. */
export type ComposerMark = 'marker' | 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'mention' | 'command';

export type ComposerLineKind = 'text' | 'quote' | 'heading' | 'list' | 'fence' | 'code';

export interface ComposerSpan {
  text: string;
  marks: ComposerMark[];
}

export interface ComposerLine {
  kind: ComposerLineKind;
  spans: ComposerSpan[];
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(\s{0,3}#{1,6})(\s+)(.*)$/;
const QUOTE = /^\s{0,3}(?:>\s?)+/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s)?/;
const COMMAND = /^\/[\w:.-]+/;

/** Split a draft into styled lines. Joining every span, line by line with '\n', gives back `text`. */
export function composerMarkdown(text: string): ComposerLine[] {
  const lines: ComposerLine[] = [];
  let fence: string | null = null;
  text.split('\n').forEach((line, index) => {
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      // A closing fence is at least as long as the opening one, of the same character.
      const closes = fenceMatch !== null && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1];
      if (closes) {
        fence = null;
        lines.push({ kind: 'fence', spans: span(line, ['marker']) });
      } else {
        lines.push({ kind: 'code', spans: span(line, ['code']) });
      }
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      lines.push({ kind: 'fence', spans: span(line, ['marker']) });
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      lines.push({
        kind: 'heading',
        spans: [...span(heading[1] + heading[2], ['marker']), ...inline(heading[3], ['bold'])],
      });
      return;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      lines.push({ kind: 'quote', spans: [...span(quote[0], ['marker']), ...inline(line.slice(quote[0].length))] });
      return;
    }
    const list = LIST.exec(line);
    if (list) {
      const [whole, indent, bullet, gap, task = ''] = list;
      lines.push({
        kind: 'list',
        spans: [...span(indent), ...span(bullet + gap + task, ['marker']), ...inline(line.slice(whole.length))],
      });
      return;
    }
    // A slash command only counts at the very start of the message, where the agent reads it.
    const command = index === 0 ? COMMAND.exec(line) : null;
    if (command) {
      lines.push({ kind: 'text', spans: [...span(command[0], ['command']), ...inline(line.slice(command[0].length))] });
      return;
    }
    lines.push({ kind: 'text', spans: inline(line) });
  });
  return lines;
}

/**
 * What a new line does at the end of a code fence that nothing closes yet:
 * it also adds the closing fence, and puts the caret on the empty line
 * between the two. Null when the new line is a plain new line.
 */
export function closeFenceOnNewline(text: string, start: number, end: number): { insert: string; caret: number } | null {
  if (start !== end) return null;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const next = text.indexOf('\n', start);
  if (text.slice(start, next === -1 ? text.length : next).trim() !== '') return null;
  const lines = composerMarkdown(text);
  const index = text.slice(0, lineStart).split('\n').length - 1;
  if (lines[index]?.kind !== 'fence') return null;
  // Fence lines alternate open, close. Only the last one, when it opens, has nothing to close it.
  const fences = lines.flatMap((line, at) => (line.kind === 'fence' ? [at] : []));
  if (fences.length % 2 === 0 || fences[fences.length - 1] !== index) return null;
  const marker = FENCE.exec(text.slice(lineStart, start))?.[0];
  if (!marker) return null;
  return { insert: `\n\n${marker}`, caret: start + 1 };
}

/** A change to the draft: replace `from`..`to` with `insert`, then put the caret at `caret`. */
export interface ComposerEdit {
  from: number;
  to: number;
  insert: string;
  caret: number;
}

interface DraftLine {
  kind: ComposerLineKind;
  /** On a fence line: whether it opens or closes its code block. */
  side?: 'open' | 'close';
  text: string;
  start: number;
  end: number;
}

function draftLines(text: string): DraftLine[] {
  const kinds = composerMarkdown(text);
  let at = 0;
  let open = false;
  return text.split('\n').map((line, index) => {
    const out: DraftLine = { kind: kinds[index].kind, text: line, start: at, end: at + line.length };
    if (out.kind === 'fence') {
      // Fence lines alternate open, close.
      open = !open;
      out.side = open ? 'open' : 'close';
    }
    at = out.end + 1;
    return out;
  });
}

function lineAt(lines: DraftLine[], offset: number): number {
  return lines.findIndex((line) => offset <= line.end);
}

const isBlank = (line: DraftLine | undefined) => line !== undefined && line.text.trim() === '';

/**
 * Where the caret goes after Up or Down puts it on a closing fence. The
 * composer hides those backticks, so the caret does not stay there. Down
 * goes on to the line below the code block, and adds that line when the
 * block ends the draft. Up goes back to the end of the last code line.
 */
export function stepOverClosingFence(text: string, caret: number, direction: 'up' | 'down'): ComposerEdit | null {
  const lines = draftLines(text);
  const index = lineAt(lines, caret);
  const fence = lines[index];
  if (fence?.side !== 'close') return null;
  if (direction === 'up') {
    const last = lines[index - 1];
    return last.kind === 'code' ? { from: last.end, to: last.end, insert: '', caret: last.end } : null;
  }
  const below = lines[index + 1];
  if (below) return { from: below.start, to: below.start, insert: '', caret: below.start };
  return { from: fence.end, to: fence.end, insert: '\n', caret: fence.end + 1 };
}

/**
 * What a new line (Shift+Enter) does at the end of a code block. On an empty
 * last code line it leaves the block: the empty line goes, and the caret
 * moves to a plain line below the closing fence. A block with no closing
 * fence yet gets one. On the closing fence itself, the new line goes below
 * the fence, wherever the caret is on it. Null for a plain new line.
 */
export function leaveCodeBlockOnNewline(text: string, start: number, end: number): ComposerEdit | null {
  if (start !== end) return null;
  const lines = draftLines(text);
  const index = lineAt(lines, start);
  const line = lines[index];
  if (line.side === 'close') return { from: line.end, to: line.end, insert: '\n', caret: line.end + 1 };
  if (line.kind !== 'code' || !isBlank(line)) return null;
  const fence = lines[index + 1];
  if (fence === undefined) {
    const opening = lines.slice(0, index).reverse().find((l) => l.side === 'open');
    const marker = opening ? FENCE.exec(opening.text)?.[0] : undefined;
    if (!marker) return null;
    return { from: line.start, to: line.end, insert: `${marker}\n`, caret: line.start + marker.length + 1 };
  }
  if (fence.side !== 'close') return null;
  // Take out the empty line with the line break before it, then rewrite the fence.
  const from = line.start - 1;
  // An empty line below the block is already the new line.
  const insert = isBlank(lines[index + 2]) ? `\n${fence.text}` : `\n${fence.text}\n`;
  return { from, to: fence.end, insert, caret: from + `\n${fence.text}\n`.length };
}

/**
 * What Backspace does at the start of the line below a code block. Without
 * this, it would join that line onto the hidden closing fence, and the block
 * would then run to the end of the draft. An empty line goes; a line with
 * text stays. In both cases the caret moves to the end of the last code line.
 */
export function backspaceAfterCodeBlock(text: string, start: number, end: number): ComposerEdit | null {
  if (start !== end) return null;
  const lines = draftLines(text);
  const index = lineAt(lines, start);
  const line = lines[index];
  if (start !== line.start || index < 2) return null;
  const fence = lines[index - 1];
  const last = lines[index - 2];
  if (fence.side !== 'close' || last.kind !== 'code') return null;
  if (isBlank(line)) return { from: fence.end, to: line.end, insert: '', caret: last.end };
  return { from: start, to: start, insert: '', caret: last.end };
}

/**
 * Ends each quote at the first line without `>`, as the composer shows it.
 *
 * In CommonMark a plain line after `> quote` is a "lazy continuation": it
 * joins the quoted paragraph. The composer styles each line on its own, so
 * `> quote` then `my reply` looks like a quote and a reply while typed, but
 * rendered as one quote. A blank line before the plain line makes the
 * rendered message match the composer. Lines in a code fence stay as they are.
 */
export function endQuotesAtPlainLines(text: string): string {
  if (!text.includes('>')) return text;
  const out: string[] = [];
  let fence: string | null = null;
  let inQuote = false;
  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch !== null && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) fence = null;
      out.push(line);
      continue;
    }
    const quote = QUOTE.test(line);
    if (inQuote && !quote && line.trim() !== '') out.push('');
    if (!quote && fenceMatch) fence = fenceMatch[1];
    inQuote = quote;
    out.push(line);
  }
  return out.join('\n');
}

// Order matters: code spans first (nothing inside them is Markdown), then the
// double markers before the single ones.
const INLINE =
  /(`+)([^`]|[^`].*?[^`])\1(?!`)|\*\*(?=\S)(.*?\S)\*\*|__(?=\S)(.*?\S)__|~~(?=\S)(.*?\S)~~|\*(?=[^\s*])(.*?[^\s*])\*|_(?=[^\s_])(.*?[^\s_])_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|@([\w./~-]*[\w/~-])/g;

/** Inline Markdown in one line. Unclosed markers stay plain text. */
function inline(text: string, base: ComposerMark[] = []): ComposerSpan[] {
  const out: ComposerSpan[] = [];
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const before = start > 0 ? text[start - 1] : '';
    const lead = m[0][0];
    // `_` and `@` only start at a word edge: snake_case and email@host stay plain.
    if ((lead === '_' || lead === '@') && /\w/.test(before)) {
      re.lastIndex = start + 1;
      continue;
    }
    out.push(...span(text.slice(last, start), base));
    if (m[1] !== undefined) {
      out.push(...span(m[1], [...base, 'code', 'marker']), ...span(m[2], [...base, 'code']), ...span(m[1], [...base, 'code', 'marker']));
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const marker = m[0].slice(0, 2);
      out.push(...span(marker, [...base, 'marker']), ...inline(m[3] ?? m[4], [...base, 'bold']), ...span(marker, [...base, 'marker']));
    } else if (m[5] !== undefined) {
      out.push(...span('~~', [...base, 'marker']), ...inline(m[5], [...base, 'strike']), ...span('~~', [...base, 'marker']));
    } else if (m[6] !== undefined || m[7] !== undefined) {
      out.push(...span(lead, [...base, 'marker']), ...inline(m[6] ?? m[7], [...base, 'italic']), ...span(lead, [...base, 'marker']));
    } else if (m[8] !== undefined) {
      out.push(
        ...span('[', [...base, 'marker']),
        ...span(m[8], [...base, 'link']),
        ...span(`](${m[9]})`, [...base, 'marker']),
      );
    } else if (m[10] !== undefined) {
      out.push(...span(m[10], [...base, 'link']));
    } else {
      out.push(...span(m[0], [...base, 'mention']));
    }
    last = start + m[0].length;
  }
  out.push(...span(text.slice(last), base));
  return out;
}

function span(text: string, marks: ComposerMark[] = []): ComposerSpan[] {
  return text ? [{ text, marks }] : [];
}
