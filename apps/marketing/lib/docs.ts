import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { Marked, type Tokens } from "marked";

/**
 * The documentation section at `/docs/<slug>`.
 *
 * One markdown file per page in `content/docs/<slug>.md`, with `title` and
 * `description` in the frontmatter. The ORDER and the grouping come from
 * {@link DOCS_NAV} below rather than from the files, because the sidebar, the
 * prev/next links and the sitemap all need the same order, and a number in
 * each file's frontmatter is one more thing to renumber by hand.
 *
 * A file that exists but is not in the nav is an error, and so is a nav entry
 * with no file. Either one is a page somebody cannot reach.
 *
 * All reads happen at build time.
 */

const DOCS_DIR = path.join(process.cwd(), "content", "docs");

export interface DocsNavSection {
  title: string;
  slugs: string[];
}

export const DOCS_NAV: DocsNavSection[] = [
  {
    title: "Getting started",
    slugs: ["quickstart", "install", "connect-agents"],
  },
  {
    title: "Sessions",
    slugs: ["sessions", "sandboxes", "repository-setup", "skills"],
  },
  {
    title: "Pull requests",
    slugs: ["pull-requests", "fix-pull-requests", "merge-queue", "code-review"],
  },
  {
    title: "Integrations",
    slugs: ["integrations", "integrations-slack", "integrations-webhook", "integrations-linear", "integrations-github-issues", "integrations-posthog-inbox", "workflows", "loops", "slack", "mcp-servers"],
  },
  {
    title: "Account",
    slugs: ["billing", "insights"],
  },
  {
    title: "API",
    slugs: ["api", "api-reference", "webhooks", "mcp"],
  },
  {
    title: "Reference",
    slugs: ["security", "troubleshooting"],
  },
];

export interface DocHeading {
  id: string;
  text: string;
  depth: number;
}

export interface DocMeta {
  slug: string;
  title: string;
  /** Short label for the sidebar. Falls back to the title. */
  navLabel: string;
  description: string;
  section: string;
}

export interface Doc extends DocMeta {
  html: string;
  headings: DocHeading[];
  /** Plain text of the body, for the search index. */
  text: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripTags(html: string): string {
  return html
    .replace(/<\/?(?:a|strong|em|code|span)(?:\s[^>]*)?>/g, "")
    .replace(/<button[^>]*>.*?<\/button>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A fresh `Marked` per page, never the shared `marked` singleton: the guides
 * and the blog render through that one, and a renderer installed here would
 * change their output too.
 */
function render(markdown: string): { html: string; headings: DocHeading[] } {
  const headings: DocHeading[] = [];
  const used = new Map<string, number>();
  const md = new Marked();

  md.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        const base = slugify(inner) || "section";
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        if (token.depth === 2 || token.depth === 3) {
          headings.push({ id, text: stripTags(inner), depth: token.depth });
        }
        return `<h${token.depth} id="${id}" class="group scroll-mt-24"><a href="#${id}" class="docs-anchor">${inner}</a></h${token.depth}>\n`;
      },
      code(token: Tokens.Code) {
        const lang = (token.lang ?? "").trim().split(/\s+/)[0];
        const label = lang ? `<span class="docs-code-lang">${escapeHtml(lang)}</span>` : "";
        return `<div class="docs-code">${label}<button type="button" class="docs-copy" data-copy aria-label="Copy code">Copy</button><pre><code>${escapeHtml(token.text)}</code></pre></div>\n`;
      },
      blockquote(this: { parser: { parse(t: Tokens.Generic[]): string } }, token: Tokens.Blockquote) {
        return `<div class="docs-note">${this.parser.parse(token.tokens)}</div>\n`;
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const external = /^https?:\/\//.test(token.href);
        const attrs = external ? ' target="_blank" rel="noreferrer"' : "";
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<a href="${escapeHtml(token.href)}"${title}${attrs}>${inner}</a>`;
      },
    },
  });

  const html = md.parse(markdown, { async: false });
  return { html, headings };
}

interface RawFrontmatter {
  title?: unknown;
  description?: unknown;
  navLabel?: unknown;
}

const sectionOf = new Map<string, string>(
  DOCS_NAV.flatMap((s) => s.slugs.map((slug) => [slug, s.title] as const))
);

function readDoc(slug: string): Doc {
  const file = path.join(DOCS_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`content/docs/${slug}.md: listed in DOCS_NAV but the file is missing`);
  }
  const { data, content } = matter(fs.readFileSync(file, "utf8"));
  const fm = data as RawFrontmatter;
  const title = typeof fm.title === "string" ? fm.title : "";
  const description = typeof fm.description === "string" ? fm.description : "";
  if (!title) throw new Error(`content/docs/${slug}.md: missing \`title\``);
  if (!description) throw new Error(`content/docs/${slug}.md: missing \`description\``);

  const { html, headings } = render(content);
  return {
    slug,
    title,
    navLabel: typeof fm.navLabel === "string" && fm.navLabel ? fm.navLabel : title,
    description,
    section: sectionOf.get(slug) ?? "",
    html,
    headings,
    text: stripTags(html),
  };
}

let cache: Doc[] | null = null;

/** Every page, in sidebar order. */
export function listDocs(): Doc[] {
  if (cache) return cache;
  const ordered = DOCS_NAV.flatMap((s) => s.slugs);
  const onDisk = fs.existsSync(DOCS_DIR)
    ? fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
    : [];
  const orphan = onDisk.find((slug) => !sectionOf.has(slug));
  if (orphan) {
    throw new Error(`content/docs/${orphan}.md: not listed in DOCS_NAV, so nothing links to it`);
  }
  cache = ordered.map(readDoc);
  return cache;
}

export function getDoc(slug: string): Doc | null {
  return listDocs().find((d) => d.slug === slug) ?? null;
}

/** The sidebar tree, with titles only. Small enough to hand to a client component. */
export function docsNavTree(): Array<{ title: string; pages: Array<{ slug: string; label: string }> }> {
  const docs = listDocs();
  return DOCS_NAV.map((section) => ({
    title: section.title,
    pages: section.slugs.map((slug) => ({
      slug,
      label: docs.find((d) => d.slug === slug)?.navLabel ?? slug,
    })),
  }));
}

export function docNeighbours(slug: string): { prev: DocMeta | null; next: DocMeta | null } {
  const docs = listDocs();
  const i = docs.findIndex((d) => d.slug === slug);
  const meta = (d: Doc | undefined): DocMeta | null =>
    d
      ? {
          slug: d.slug,
          title: d.title,
          navLabel: d.navLabel,
          description: d.description,
          section: d.section,
        }
      : null;
  return { prev: meta(docs[i - 1]), next: meta(docs[i + 1]) };
}
