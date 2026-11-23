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
