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
  | { type: 'image'; src: string; alt: string; width?: number; height?: number }
  | { type: 'hr' };
export type MdImage = Extract<MdBlock, { type: 'image' }>;
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

function pushText(out: Piece[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + text };
  else out.push({ type: 'text', text });
}

/** An http(s) URL with no credentials or control characters, like `safeExternalUrl`. Other image sources are dropped. */
export function safeImageUrl(value: string): string | null {
  try {
    if (value.length > 4096 || Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const IMG_TAG = /<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
/** The `src`, `alt`, `width` and `height` of one `<img>` tag. */
function imgTag(tag: string): { src: string; alt: string; width?: number; height?: number } {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    const name = match[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  const size = (value: string | undefined) => {
    const number = value && /^\s*\d+(?:px)?\s*$/i.test(value) ? Number.parseInt(value, 10) : NaN;
    return number > 0 && number <= 100000 ? number : undefined;
  };
  const width = size(attrs.width), height = size(attrs.height);
  return { src: (attrs.src ?? '').trim(), alt: (attrs.alt ?? '').trim(), ...(width ? { width } : null), ...(height ? { height } : null) };
}

/** Inline nodes, plus images when the caller can show them as blocks. */
type Piece = MdInline | MdImage;
/**
 * An image becomes an image piece where images are allowed. Elsewhere (tables,
 * headings) it stays a link, or its alt text when the source is not safe.
 */
function pushImage(out: Piece[], image: { src: string; alt: string; width?: number; height?: number }, images: boolean) {
  const src = safeImageUrl(image.src);
  // React Native's Image cannot draw SVG (most badges), so an SVG stays a link.
  if (src && images && !/\.svgz?$/i.test(src.split(/[?#]/)[0])) out.push({ type: 'image', ...image, src });
  else if (src) out.push({ type: 'link', href: src, children: [{ type: 'text', text: image.alt || 'Image' }] });
  else pushText(out, image.alt);
}
/** Wraps each run of inline nodes with `wrap`, so images inside a link or emphasis come out to the top. */
function lift(children: Piece[], wrap: (run: MdInline[]) => MdInline, into: Piece[]) {
  const split = children.some((child) => child.type === 'image');
  let run: MdInline[] = [];
  const flush = () => { const nodes = split ? trimRun(run) : run; if (nodes.length) into.push(wrap(nodes)); run = []; };
  for (const child of children) {
    if (child.type === 'image') { flush(); into.push(child); } else run.push(child);
  }
  flush();
}

function inlines(tokens: Token[] | undefined, depth?: number): MdInline[];
function inlines(tokens: Token[] | undefined, depth: number, images: true): Piece[];
function inlines(tokens: Token[] | undefined, depth = 0, images = false): Piece[] {
  const out: Piece[] = [];
  // `<summary>` text reads as a heading line, so it is bold until its closing tag.
  let summary: Piece[] | null = null;
  const target = () => summary ?? out;
  const nested = (children: Token[] | undefined) => images ? inlines(children, depth + 1, true) : inlines(children, depth + 1);
  for (const token of tokens ?? []) {
    const into = target();
    switch (token.type) {
      case 'text': case 'escape': {
        const children = (token as Tokens.Text).tokens;
        if (children?.length && depth < MAX_DEPTH) {
          for (const child of nested(children)) {
            if (child.type === 'text') pushText(into, child.text); else into.push(child);
          }
        } else pushText(into, decodeEntities(token.text));
        break;
      }
      case 'strong': case 'em': case 'del': {
        const kind = token.type;
        if (depth < MAX_DEPTH) lift(nested((token as Tokens.Strong).tokens), (children) => ({ type: kind, children }), into);
        else into.push({ type: kind, children: [{ type: 'text', text: token.text }] });
        break;
      }
      case 'codespan': into.push({ type: 'code', text: decodeEntities(token.text) }); break;
      case 'br': into.push({ type: 'br' }); break;
      case 'link': {
        const link = token as Tokens.Link;
        const children = depth < MAX_DEPTH ? nested(link.tokens) : [];
        if (!children.length) into.push({ type: 'link', href: link.href, children: [{ type: 'text', text: link.href }] });
        // A linked image (a badge or a screenshot) shows as the image. Other link text keeps its link.
        else lift(children, (run) => ({ type: 'link', href: link.href, children: run }), into);
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        pushImage(into, { src: image.href, alt: decodeEntities(image.text).trim() }, images);
        break;
      }
      case 'html': {
        const tag = token.text.trim().toLowerCase();
        if (/^<br\s*\/?>$/.test(tag)) into.push({ type: 'br' });
        else if (tag.startsWith('<img')) pushImage(into, imgTag(token.text), images);
        else if (tag.startsWith('<summary')) summary = [];
        else if (tag.startsWith('</summary') && summary) {
          if (summary.length) lift(summary, (children) => ({ type: 'strong', children }), out);
          summary = null;
        } else pushText(into, stripHtml(token.text));
        break;
      }
      default:
        if ('text' in token && typeof token.text === 'string') pushText(into, decodeEntities(token.text));
    }
  }
  if (summary?.length) lift(summary, (children) => ({ type: 'strong', children }), out);
  return out;
}

/** Drops the white space and line breaks at the ends of a paragraph that an image split. */
function trimRun(run: MdInline[]): MdInline[] {
  const nodes = [...run];
  const blank = (node: MdInline | undefined) => node?.type === 'br' || (node?.type === 'text' && !node.text.trim());
  while (blank(nodes[0])) nodes.shift();
  while (blank(nodes[nodes.length - 1])) nodes.pop();
  if (nodes[0]?.type === 'text') nodes[0] = { type: 'text', text: nodes[0].text.trimStart() };
  const last = nodes[nodes.length - 1];
  if (last?.type === 'text') nodes[nodes.length - 1] = { type: 'text', text: last.text.trimEnd() };
  return nodes;
}

/** A paragraph with images becomes text paragraphs and image blocks, in order. */
function paragraphs(pieces: Piece[], out: MdBlock[]) {
  if (!pieces.some((piece) => piece.type === 'image')) {
    if (pieces.length) out.push({ type: 'paragraph', children: pieces as MdInline[] });
    return;
  }
  let run: MdInline[] = [];
  const flush = () => { const children = trimRun(run); if (children.length) out.push({ type: 'paragraph', children }); run = []; };
  for (const piece of pieces) {
    if (piece.type === 'image') { flush(); out.push(piece); } else run.push(piece);
  }
  flush();
}

/** Block HTML keeps its text and its `<img>` tags, in order. */
function htmlBlocks(html: string, out: MdBlock[]) {
  let rest = 0;
  const text = (part: string) => { const value = stripHtml(part).trim(); if (value) out.push({ type: 'paragraph', children: [{ type: 'text', text: value }] }); };
  for (const match of html.matchAll(IMG_TAG)) {
    const at = match.index ?? 0;
    text(html.slice(rest, at));
    rest = at + match[0].length;
    const image: Piece[] = [];
    pushImage(image, imgTag(match[0]), true);
    for (const piece of image) out.push(piece.type === 'image' ? piece : { type: 'paragraph', children: [piece] });
  }
  text(html.slice(rest));
}

function blocks(tokens: Token[], depth: number): MdBlock[] {
  const out: MdBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space': case 'def': break;
      case 'paragraph': case 'text': {
        paragraphs(inlines((token as Tokens.Paragraph).tokens ?? [{ type: 'text', raw: token.raw, text: token.text } as Tokens.Text], depth, true), out);
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
        htmlBlocks(summary ? token.text.replace(summary[0], '') : token.text, out);
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
 * flavour, like web. Raw HTML is reduced to its text and never rendered,
 * except `<img>` tags, which become image blocks like markdown images.
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

/**
 * The most characters and lines that one native `Text` gets. Android draws a
 * `Text` into one GPU texture. A `Text` taller than the largest texture (8k
 * to 16k px) draws blank, so long text goes into several `Text` views.
 */
export const TEXT_CHUNK_CHARS = 1500;
export const TEXT_CHUNK_LINES = 40;

export interface ChunkOptions {
  chars?: number;
  lines?: number;
  /** Text that wraps can also be cut at a space. Code does not wrap, so it is cut only at a newline. */
  wrap?: boolean;
}

/**
 * Where to cut text into chunks, as `[start, end)` ranges. A cut goes at a
 * newline when it can, then at a space. The newline or space at a cut is
 * not in a chunk: the next `Text` starts on a new line in its place.
 */
export function chunkRanges(text: string, { chars = TEXT_CHUNK_CHARS, lines = TEXT_CHUNK_LINES, wrap = true }: ChunkOptions = {}): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (text.length - start > 0) {
    let limit = Math.min(text.length, start + chars);
    for (let index = start + 1, newlines = 0; index < limit; index += 1) {
      if (text[index] === '\n' && ++newlines >= lines) { limit = index; break; }
    }
    if (limit >= text.length) { ranges.push([start, text.length]); break; }
    if (text[limit] === '\n') { ranges.push([start, limit]); start = limit + 1; continue; }
    const floor = start + Math.floor((limit - start) / 2);
    let cut = text.lastIndexOf('\n', limit - 1);
    if (cut <= floor && wrap) {
      for (let index = limit - 1; index > floor; index -= 1) if (/\s/.test(text[index])) { cut = index; break; }
    }
    if (cut > floor) { ranges.push([start, cut]); start = cut + 1; continue; }
    // No good place to cut. Do not split a surrogate pair.
    if (/[\uD800-\uDBFF]/.test(text[limit - 1]) && limit - 1 > start) limit -= 1;
    ranges.push([start, limit]);
    start = limit;
  }
  return ranges.length ? ranges : [[0, 0]];
}

/** Text in chunks that each fit in one native `Text`. */
export function chunkText(text: string, options?: ChunkOptions): string[] {
  const ranges = chunkRanges(text, options);
  return ranges.length === 1 ? [text] : ranges.map(([start, end]) => text.slice(start, end));
}

const inlineLength = (node: MdInline): number => node.type === 'br' ? 1
  : node.type === 'text' || node.type === 'code' ? node.text.length : node.children.reduce((sum, child) => sum + inlineLength(child), 0);

/** The inline nodes for the characters `[from, to)` of `inlineText(nodes)`. Bold, links and other marks stay on each part. */
function sliceInlines(nodes: MdInline[], from: number, to: number): MdInline[] {
  const out: MdInline[] = [];
  let position = 0;
  for (const node of nodes) {
    const start = position;
    position += inlineLength(node);
    if (position <= from || start >= to) continue;
    if (node.type === 'br') out.push(node);
    else if (node.type === 'text' || node.type === 'code') out.push({ ...node, text: node.text.slice(Math.max(0, from - start), to - start) });
    else {
      const children = sliceInlines(node.children, from - start, to - start);
      if (children.length) out.push({ ...node, children });
    }
  }
  return out;
}

/** A paragraph in chunks that each fit in one native `Text`. Short paragraphs come back as one chunk, unchanged. */
export function chunkInlines(nodes: MdInline[], options?: ChunkOptions): MdInline[][] {
  const ranges = chunkRanges(inlineText(nodes), options);
  return ranges.length === 1 ? [nodes] : ranges.map(([start, end]) => sliceInlines(nodes, start, end));
}
