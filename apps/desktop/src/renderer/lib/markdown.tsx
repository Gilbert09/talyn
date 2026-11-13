import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { MermaidDiagram, mermaidSourceFromPre } from './mermaid';
import { cn } from './utils';

/**
 * Markdown renderer for both the agent transcript feed and the
 * theme-adaptive panels (PR detail, etc.). Backed by react-markdown +
 * remark-gfm (tables, task lists, strikethrough, autolinks) and
 * rehype-raw → rehype-sanitize so raw HTML common in PR/review bodies
 * (e.g. collapsible `<details>` sections) renders safely. ```mermaid
 * fences render as diagrams, as they do on GitHub — see `mermaid.tsx`.
 *
 * Variants:
 *   - `feed`    — the always-dark agent transcript (bg #1a1a1a).
 *   - `surface` — theme-adaptive panels like the PR detail sheet.
 *   - `prose`   — `surface` colours with more room, for the agent's replies.
 *                 A reply can be a long report with headings, lists and many
 *                 code spans, and the compact spacing packs it into one dense
 *                 block. The caller also caps the line length (`PROSE_MEASURE`).
 *   - `inline`  — inline marks only, for a heading or a table cell.
 */
export type MarkdownVariant = 'feed' | 'surface' | 'prose' | 'inline';

/**
 * A comfortable line length for a `prose` reply. A full-width line in a wide
 * window holds 180+ characters, and the eye loses its place on the way back.
 */
export const PROSE_MEASURE = 'max-w-[76ch]';

/** Spacing and type sizes that differ between `prose` and the compact variants. */
interface MdSpacing {
  p: string;
  h1: string;
  h2: string;
  h3: string;
  list: string;
  inlineCode: string;
  fence: string;
}

const COMPACT: MdSpacing = {
  p: 'my-1 leading-relaxed',
  h1: 'mt-2 mb-1 text-base font-semibold',
  h2: 'mt-2 mb-1 text-sm font-semibold',
  h3: 'mt-2 mb-1 text-sm font-medium',
  list: 'my-1 space-y-0.5',
  inlineCode: 'px-1 text-xs',
  fence: 'my-1',
};

// `first:mt-0` / `last:mb-0` keep the reply flush with its container: the
// block margins are for the gaps between blocks, not around the reply.
const ROOMY: MdSpacing = {
  p: 'my-2.5 leading-[1.65] first:mt-0 last:mb-0',
  h1: 'mt-6 mb-2 text-base font-semibold first:mt-0',
  h2: 'mt-6 mb-2 text-[15px] font-semibold first:mt-0',
  h3: 'mt-5 mb-1.5 text-sm font-semibold first:mt-0',
  list: 'my-2.5 space-y-1.5 leading-[1.65] marker:text-muted-foreground first:mt-0 last:mb-0',
  inlineCode: 'px-[0.3em] py-px text-[0.9em]',
  fence: 'my-3 first:mt-0 last:mb-0',
};

interface MdClasses {
  heading: string;
  fence: string;
  inlineCode: string;
  link: string;
  blockquote: string;
  hr: string;
  border: string;
  muted: string;
}

const FEED: MdClasses = {
  heading: 'text-zinc-100',
  fence: 'bg-black/40',
  inlineCode: 'bg-white/10',
  link: 'text-blue-400 hover:text-blue-300',
  blockquote: 'border-zinc-600 text-zinc-300',
  hr: 'border-zinc-700/60',
  border: 'border-zinc-700/60',
  muted: 'text-zinc-400',
};

const SURFACE: MdClasses = {
  heading: 'text-foreground',
  fence: 'border border-border bg-muted/60 text-foreground',
  inlineCode: 'bg-muted',
  link: 'text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300',
  blockquote: 'border-border text-muted-foreground',
  hr: 'border-border',
  border: 'border-border',
  muted: 'text-muted-foreground',
};

// Allow GitHub's collapsible <details>/<summary> through the sanitizer
// (the default schema is otherwise GitHub-equivalent — task-list inputs,
// tables, etc. are already permitted).
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: Array.from(
    new Set([...(defaultSchema.tagNames ?? []), 'details', 'summary'])
  ),
  attributes: {
    ...defaultSchema.attributes,
    details: [...((defaultSchema.attributes?.details as string[]) ?? []), 'open'],
  },
};

const REMARK_PLUGINS = [remarkGfm];
// rehype-raw must run before sanitize: it turns raw HTML strings into
// hast nodes, which sanitize then prunes against the schema.
const REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]] as const;

function makeComponents(c: MdClasses, forceDark: boolean, s: MdSpacing = COMPACT): Components {
  return {
    p: ({ children }) => (
      <p className={cn(s.p, '[overflow-wrap:anywhere]')}>{children}</p>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn('underline underline-offset-2 [overflow-wrap:anywhere]', c.link)}
      >
        {children}
      </a>
    ),
    h1: ({ children }) => <div className={cn(s.h1, c.heading)}>{children}</div>,
    h2: ({ children }) => <div className={cn(s.h2, c.heading)}>{children}</div>,
    h3: ({ children }) => <div className={cn(s.h3, c.heading)}>{children}</div>,
    h4: ({ children }) => <div className={cn(s.h3, c.heading)}>{children}</div>,
    h5: ({ children }) => <div className={cn(s.h3, c.heading)}>{children}</div>,
    h6: ({ children }) => <div className={cn(s.h3, c.heading)}>{children}</div>,
    ul: ({ children }) => <ul className={cn('ml-5 list-disc', s.list)}>{children}</ul>,
    ol: ({ children }) => <ol className={cn('ml-5 list-decimal', s.list)}>{children}</ol>,
    li: ({ children }) => <li className="[overflow-wrap:anywhere]">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote
        className={cn('my-1 border-l-2 pl-3 [overflow-wrap:anywhere]', c.blockquote)}
      >
        {children}
      </blockquote>
    ),
    hr: () => <hr className={cn('my-2', c.hr)} />,
    pre: ({ children }) => {
      // A ```mermaid fence becomes a diagram rather than a code block. The
      // swap happens at the <pre> (not the <code>) so the diagram is not
      // trapped inside a monospace, pre-wrapped box.
      const diagram = mermaidSourceFromPre(children);
      if (diagram !== null) {
        return (
          <MermaidDiagram
            code={diagram}
            forceDark={forceDark}
            classes={{ fence: c.fence, border: c.border, muted: c.muted }}
          />
        );
      }
      return (
        <pre
          className={cn(
            s.fence,
            'max-w-full overflow-x-auto whitespace-pre-wrap rounded p-2 font-mono text-xs [overflow-wrap:anywhere]',
            // A fence with no language reaches `code` below with no
            // `language-*` class and gets the inline pill. Inside a block the
            // pill draws a band behind every line, so the block clears it.
            '[&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0',
            c.fence
          )}
        >
          {children}
        </pre>
      );
    },
    code: ({ className, children }) => {
      // Fenced blocks carry a `language-*` class and live inside <pre>
      // (styled above) — render them plain so they don't get the inline
      // pill. Everything else is inline code.
      const isBlock = /language-/.test(className ?? '');
      if (isBlock) {
        return <code className="font-mono">{children}</code>;
      }
      return (
        <code
          className={cn('rounded font-mono [overflow-wrap:anywhere]', s.inlineCode, c.inlineCode)}
        >
          {children}
        </code>
      );
    },
    table: ({ children }) => (
      <div className="my-1 overflow-x-auto">
        <table className={cn('w-full border-collapse text-xs', c.heading)}>{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className={cn('border px-2 py-1 text-left font-semibold', c.border)}>{children}</th>
    ),
    td: ({ children }) => (
      <td className={cn('border px-2 py-1 align-top', c.border)}>{children}</td>
    ),
    details: ({ children }) => (
      <details className={cn('my-1 rounded border px-3 py-2 [overflow-wrap:anywhere]', c.border)}>
        {children}
      </details>
    ),
    summary: ({ children }) => (
      <summary className={cn('cursor-pointer font-medium', c.heading)}>{children}</summary>
    ),
    img: ({ src, alt }) => (
      <img src={typeof src === 'string' ? src : undefined} alt={alt} className="max-w-full rounded" />
    ),
  };
}

const FEED_COMPONENTS = makeComponents(FEED, true);
const SURFACE_COMPONENTS = makeComponents(SURFACE, false);
const PROSE_COMPONENTS = makeComponents(SURFACE, false, ROOMY);

/**
 * Markdown inside a line of text, for a heading or a table cell.
 *
 * Agents write markdown everywhere, including in one-line fields — a code
 * review title reading "`request_id` is reused across pages" rendered its
 * backticks literally. But the surface map answers a paragraph with a `<p>` and
 * a list with a `<ul>`, and either inside a truncating single-line heading
 * breaks the row it sits in.
 *
 * So this map keeps the INLINE marks — code, emphasis, links — and flattens
 * every block element to a fragment. The text still reads correctly if an agent
 * puts a list in a title; it just does not get to lay the row out.
 */
const INLINE_COMPONENTS = {
  ...SURFACE_COMPONENTS,
  p: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  ul: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  ol: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  li: ({ children }: { children?: React.ReactNode }) => <>{children} </>,
  h1: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  h2: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  h3: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  h4: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  h5: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  h6: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  hr: () => null,
};

export function Markdown({
  text,
  variant = 'feed',
}: {
  text: string;
  variant?: MarkdownVariant;
}): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      // Cast: the tuple-with-options plugin form is valid at runtime but
      // widens awkwardly against PluggableList.
      rehypePlugins={REHYPE_PLUGINS as never}
      components={
        variant === 'inline'
          ? INLINE_COMPONENTS
          : variant === 'prose'
            ? PROSE_COMPONENTS
            : variant === 'surface'
              ? SURFACE_COMPONENTS
              : FEED_COMPONENTS
      }
    >
      {text}
    </ReactMarkdown>
  );
}

/**
 * Backwards-compatible helper kept so existing call sites read the same.
 * Prefer `<Markdown … />` in new code.
 */
export function renderMarkdownish(
  text: string,
  variant: MarkdownVariant = 'feed'
): React.ReactNode {
  return <Markdown text={text} variant={variant} />;
}
