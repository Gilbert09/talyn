import { Lexer, type Token, type Tokens } from 'marked';

/** Inline content inside a paragraph, heading, list item or table cell. */
export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MdInline[] }
  | { type: 'br' };
export type MdAlign = 'left' | 'center' | 'right' | null;
export interface MdListItem { checked: boolean | null; children: MdBlock[] }
export type MdBlock =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'heading'; depth: number; children: MdInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'blockquote'; children: MdBlock[] }
  | { type: 'table'; align: MdAlign[]; header: MdInline[][]; rows: MdInline[][][] }
  | { type: 'hr' };
export interface MdDocument { blocks: MdBlock[]; truncated: boolean }

/** The most text one message parses. Longer text is cut and marked as truncated. */
export const MARKDOWN_TEXT_LIMIT = 16000;
/** Bounds for pathological input: deep nesting and huge tables. */
const MAX_DEPTH = 8;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 20;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower];
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : lower.startsWith('#') ? parseInt(lower.slice(1), 10) : NaN;
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
/** Raw HTML is never rendered. Its tags go and its text stays. */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, ''));
}

function pushText(out: MdInline[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + text };
  else out.push({ type: 'text', text });
}

function inlines(tokens: Token[] | undefined, depth = 0): MdInline[] {
  const out: MdInline[] = [];
  // `<summary>` text reads as a heading line, so it is bold until its closing tag.
  let summary: MdInline[] | null = null;
  const target = () => summary ?? out;
  for (const token of tokens ?? []) {
    const into = target();
    switch (token.type) {
      case 'text': case 'escape': {
        const children = (token as Tokens.Text).tokens;
        if (children?.length && depth < MAX_DEPTH) {
          for (const child of inlines(children, depth + 1)) {
            if (child.type === 'text') pushText(into, child.text); else into.push(child);
          }
        } else pushText(into, decodeEntities(token.text));
        break;
      }
      case 'strong': case 'em': case 'del':
        into.push({ type: token.type, children: depth < MAX_DEPTH ? inlines((token as Tokens.Strong).tokens, depth + 1) : [{ type: 'text', text: token.text }] });
        break;
      case 'codespan': into.push({ type: 'code', text: decodeEntities(token.text) }); break;
      case 'br': into.push({ type: 'br' }); break;
      case 'link': {
        const link = token as Tokens.Link;
        const children = depth < MAX_DEPTH ? inlines(link.tokens, depth + 1) : [];
        into.push({ type: 'link', href: link.href, children: children.length ? children : [{ type: 'text', text: link.href }] });
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        into.push({ type: 'link', href: image.href, children: [{ type: 'text', text: image.text || 'Image' }] });
        break;
      }
      case 'html': {
        const tag = token.text.trim().toLowerCase();
        if (/^<br\s*\/?>$/.test(tag)) into.push({ type: 'br' });
        else if (tag.startsWith('<summary')) summary = [];
        else if (tag.startsWith('</summary') && summary) {
          if (summary.length) out.push({ type: 'strong', children: summary });
          summary = null;
        } else pushText(into, stripHtml(token.text));
        break;
      }
      default:
        if ('text' in token && typeof token.text === 'string') pushText(into, decodeEntities(token.text));
    }
  }
  if (summary?.length) out.push({ type: 'strong', children: summary });
  return out;
}

function blocks(tokens: Token[], depth: number): MdBlock[] {
  const out: MdBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space': case 'def': break;
      case 'paragraph': case 'text': {
        const children = inlines((token as Tokens.Paragraph).tokens ?? [{ type: 'text', raw: token.raw, text: token.text } as Tokens.Text], depth);
        if (children.length) out.push({ type: 'paragraph', children });
        break;
      }
      case 'heading': out.push({ type: 'heading', depth: (token as Tokens.Heading).depth, children: inlines((token as Tokens.Heading).tokens, depth) }); break;
      case 'code': out.push({ type: 'code', lang: ((token as Tokens.Code).lang ?? '').trim().split(/\s+/)[0] ?? '', text: (token as Tokens.Code).text }); break;
      case 'hr': out.push({ type: 'hr' }); break;
      case 'blockquote':
        if (depth >= MAX_DEPTH) out.push({ type: 'paragraph', children: [{ type: 'text', text: token.text }] });
        else out.push({ type: 'blockquote', children: blocks((token as Tokens.Blockquote).tokens, depth + 1) });
        break;
      case 'list': {
        const list = token as Tokens.List;
        if (depth >= MAX_DEPTH) { out.push({ type: 'paragraph', children: [{ type: 'text', text: list.raw.trim() }] }); break; }
        const start = typeof list.start === 'number' ? list.start : Number.parseInt(String(list.start), 10);
        out.push({ type: 'list', ordered: list.ordered, start: Number.isFinite(start) ? start : 1,
          items: list.items.map((item) => ({ checked: item.task ? Boolean(item.checked) : null,
            children: blocks(item.tokens.filter((child) => child.type !== 'checkbox'), depth + 1) })) });
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        const columns = Math.min(table.header.length, MAX_TABLE_COLUMNS);
        out.push({ type: 'table', align: table.align.slice(0, columns),
          header: table.header.slice(0, columns).map((cell) => inlines(cell.tokens, depth)),
          rows: table.rows.slice(0, MAX_TABLE_ROWS).map((row) => row.slice(0, columns).map((cell) => inlines(cell.tokens, depth))) });
        break;
      }
      case 'html': {
        const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(token.text);
        const title = summary ? stripHtml(summary[1]).trim() : '';
        if (title) out.push({ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: title }] }] });
        const text = stripHtml(summary ? token.text.replace(summary[0], '') : token.text).trim();
        if (text) out.push({ type: 'paragraph', children: [{ type: 'text', text }] });
        break;
      }
      default:
        if ('text' in token && typeof token.text === 'string' && token.text.trim()) out.push({ type: 'paragraph', children: [{ type: 'text', text: token.text }] });
    }
  }
  return out;
}

/**
 * Markdown to a small node tree that the native renderer draws. GitHub
 * flavour, like web. Raw HTML is reduced to its text and never rendered.
 */
export function parseMarkdown(text: string): MdDocument {
  const truncated = text.length > MARKDOWN_TEXT_LIMIT;
  const source = truncated ? text.slice(0, MARKDOWN_TEXT_LIMIT) : text;
  try {
    return { blocks: blocks(new Lexer({ gfm: true, breaks: false }).lex(source), 0), truncated };
  } catch {
    return { blocks: source.trim() ? [{ type: 'paragraph', children: [{ type: 'text', text: source }] }] : [], truncated };
  }
}

/** The words in inline content, for accessibility labels and table sizing. */
export function inlineText(children: MdInline[]): string {
  return children.map((child) => child.type === 'br' ? '\n' : child.type === 'text' || child.type === 'code' ? child.text : inlineText(child.children)).join('');
}
