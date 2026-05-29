import React from 'react';
import { cn } from './utils';

/**
 * Light-weight "markdownish" renderer. Deliberately dependency-free, but
 * covers the block + inline constructs we actually emit: fenced code,
 * headings, bullet / numbered lists, blockquotes, horizontal rules,
 * GFM tables, collapsible `<details>`/`<summary>` blocks, and inline
 * code / bold / italic / links. Anything it doesn't recognise falls
 * through as a plain paragraph, so it can never render worse than raw
 * text.
 *
 * Two variants because the colour palette differs by surface:
 *   - `feed`    — the always-dark agent transcript (bg #1a1a1a).
 *   - `surface` — theme-adaptive panels like the PR detail sheet.
 */
export type MarkdownVariant = 'feed' | 'surface';

interface MdClasses {
  heading: string;
  fence: string;
  fenceLang: string;
  inlineCode: string;
  link: string;
  blockquote: string;
  hr: string;
}

const FEED: MdClasses = {
  heading: 'text-zinc-100',
  fence: 'bg-black/40',
  fenceLang: 'text-zinc-500',
  inlineCode: 'bg-white/10',
  link: 'text-blue-400 hover:text-blue-300',
  blockquote: 'border-zinc-600 text-zinc-300',
  hr: 'border-zinc-700/60',
};

const SURFACE: MdClasses = {
  heading: 'text-foreground',
  fence: 'bg-muted text-foreground',
  fenceLang: 'text-muted-foreground',
  inlineCode: 'bg-muted',
  link: 'text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300',
  blockquote: 'border-border text-muted-foreground',
  hr: 'border-border',
};

export function renderMarkdownish(
  text: string,
  variant: MarkdownVariant = 'feed'
): React.ReactNode {
  const c = variant === 'surface' ? SURFACE : FEED;
  const parts: React.ReactNode[] = [];
  // Normalise CRLF/CR → LF first. GitHub PR bodies (and other sources)
  // often arrive as CRLF; the leftover `\r` defeats the `$`-anchored
  // heading / hr / blockquote regexes below, so those PRs would render
  // their `##` headings as raw text while LF-authored ones rendered fine.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let paragraphBuf: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuf.length === 0) return;
    const para = paragraphBuf.join('\n');
    paragraphBuf = [];
    parts.push(
      <p key={`p-${parts.length}`} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {renderInline(para, c)}
      </p>
    );
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (line.startsWith('```')) {
      flushParagraph();
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      parts.push(
        <pre
          key={`c-${parts.length}`}
          className={cn(
            'text-xs font-mono whitespace-pre-wrap [overflow-wrap:anywhere] rounded p-2 overflow-x-auto my-1 max-w-full',
            c.fence
          )}
        >
          {lang && (
            <div className={cn('text-[10px] uppercase tracking-wide mb-1', c.fenceLang)}>
              {lang}
            </div>
          )}
          {codeLines.join('\n')}
        </pre>
      );
      continue;
    }

    // Collapsible <details>/<summary> block. Common in bot review
    // comments (CI summaries, coverage tables, etc.). Collect the whole
    // block (handles nesting), pull out the <summary>, and render the
    // body recursively as markdown inside a native <details>.
    if (/^\s*<details(\s|>)/i.test(line)) {
      flushParagraph();
      const buf: string[] = [];
      let depth = 0;
      while (i < lines.length) {
        const l = lines[i];
        buf.push(l);
        depth += (l.match(/<details(\s|>)/gi) ?? []).length;
        depth -= (l.match(/<\/details>/gi) ?? []).length;
        i++;
        if (depth <= 0) break;
      }
      const inner = buf.join('\n');
      const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(inner);
      const summaryText = summaryMatch ? summaryMatch[1].trim() : 'Details';
      const body = inner
        .replace(/^\s*<details[^>]*>/i, '')
        .replace(/<\/details>\s*$/i, '')
        .replace(/<summary>[\s\S]*?<\/summary>/i, '')
        .trim();
      parts.push(
        <details
          key={`d-${parts.length}`}
          className={cn('my-1 rounded border px-3 py-2 [overflow-wrap:anywhere]', c.hr)}
        >
          <summary className={cn('cursor-pointer font-medium', c.heading)}>
            {renderInline(stripTags(summaryText), c)}
          </summary>
          {body && <div className="mt-2">{renderMarkdownish(body, variant)}</div>}
        </details>
      );
      continue;
    }

    // GFM table: a header row of `| a | b |` immediately followed by a
    // delimiter row of `| --- | :--: |`.
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1])
    ) {
      flushParagraph();
      const header = splitTableRow(line);
      i += 2; // consume header + delimiter
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      parts.push(
        <div key={`t-${parts.length}`} className="my-1 overflow-x-auto">
          <table className={cn('w-full border-collapse text-xs', c.heading)}>
            <thead>
              <tr>
                {header.map((cell, idx) => (
                  <th
                    key={idx}
                    className={cn('border px-2 py-1 text-left font-semibold', c.hr)}
                  >
                    {renderInline(cell, c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {header.map((_, cIdx) => (
                    <td key={cIdx} className={cn('border px-2 py-1 align-top', c.hr)}>
                      {renderInline(row[cIdx] ?? '', c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Heading (#..######).
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const sizeClass =
        level <= 1
          ? 'text-base font-semibold'
          : level === 2
            ? 'text-sm font-semibold'
            : 'text-sm font-medium';
      parts.push(
        <div key={`h-${parts.length}`} className={cn('mt-2 mb-1', c.heading, sizeClass)}>
          {renderInline(heading[2], c)}
        </div>
      );
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      parts.push(<hr key={`hr-${parts.length}`} className={cn('my-2', c.hr)} />);
      i++;
      continue;
    }

    // List block (consecutive bullet or numbered items).
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      parts.push(
        <ListTag
          key={`l-${parts.length}`}
          className={cn('my-1 ml-5 space-y-0.5', ordered ? 'list-decimal' : 'list-disc')}
        >
          {items.map((item, idx) => (
            <li key={idx} className="[overflow-wrap:anywhere]">
              {renderInline(item, c)}
            </li>
          ))}
        </ListTag>
      );
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      parts.push(
        <blockquote
          key={`q-${parts.length}`}
          className={cn('my-1 border-l-2 pl-3 [overflow-wrap:anywhere]', c.blockquote)}
        >
          {renderInline(quoteLines.join('\n'), c)}
        </blockquote>
      );
      continue;
    }

    paragraphBuf.push(line);
    i++;
  }
  flushParagraph();
  return parts;
}

/** Split a GFM table row into trimmed cells, dropping the outer pipes. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => cell.trim());
}

/** Strip simple HTML tags (e.g. <b>, <code>) so a <summary> renders as
 *  plain text rather than literal angle-bracket markup. */
function stripTags(text: string): string {
  return text.replace(/<\/?[a-z][^>]*>/gi, '').trim();
}

/**
 * Inline span parser: handles `code`, **bold**, __bold__, *italic*,
 * _italic_, and [text](url) links in one pass, in priority order so a
 * code span is never reformatted as bold/italic. Recurses one level so
 * bold/italic can contain links and inline code.
 */
function renderInline(text: string, c: MdClasses): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  const re =
    /(`[^`]+`)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) {
      nodes.push(
        <code
          key={key++}
          className={cn('font-mono text-xs rounded px-1 [overflow-wrap:anywhere]', c.inlineCode)}
        >
          {m[1].slice(1, -1)}
        </code>
      );
    } else if (m[2] && m[3]) {
      nodes.push(
        <a
          key={key++}
          href={m[3]}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('underline underline-offset-2 [overflow-wrap:anywhere]', c.link)}
        >
          {m[2]}
        </a>
      );
    } else if (m[4] || m[5]) {
      nodes.push(
        <strong key={key++} className="font-semibold">
          {renderInline(m[4] ?? m[5], c)}
        </strong>
      );
    } else if (m[6] || m[7]) {
      nodes.push(<em key={key++}>{renderInline(m[6] ?? m[7], c)}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
