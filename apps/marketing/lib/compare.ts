import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";

/**
 * Comparison pages at `/compare/<slug>` — "Talyn vs <thing>".
 *
 * Markdown, on the same build-time pipeline as `lib/guides.ts`, and for the
 * same reason the guides are: these are prose-first. The house exemplar is
 * `content/guides/github-merge-queue-alternative.md`, which predates this
 * directory and stays at its own URL because it is indexed there.
 *
 * The register is the thing to get right, and it is not the usual one. A
 * comparison page written to make the competitor look bad is worth nothing:
 * the reader can tell, and one of those poisons every other page on the site.
 * So every page here carries two sections that a marketing page normally does
 * not — what Talyn does NOT do, and when you should use theirs instead — and
 * every factual claim about somebody else's product carries a source link and
 * the date it was checked. A competitor's pricing page changes without telling
 * us; an undated claim quietly becomes a lie.
 *
 * All reads happen at build time.
 */

const COMPARE_DIR = path.join(process.cwd(), "content", "compare");

interface RawFrontmatter {
  title?: unknown;
  description?: unknown;
  competitor?: unknown;
  category?: unknown;
  verdict?: unknown;
  updated?: unknown;
  navLabel?: unknown;
  sources?: unknown;
  related?: unknown;
  relatedFeatures?: unknown;
}

export interface CompareSource {
  label: string;
  url: string;
}

export interface CompareMeta {
  slug: string;
  title: string;
  description: string;
  /** Display name of the other product, e.g. "CodeRabbit". */
  competitor: string;
  /** Which group this sits in on the hub page. */
  category: string;
  /**
   * One sentence on when to pick theirs. Rendered above the fold, because
   * burying it at the bottom is how a comparison page loses its credibility.
   */
  verdict: string;
  /** Short label for the nav and footer. Falls back to the title. */
  navLabel: string;
  /** ISO `YYYY-MM-DD`. Shown, and the sitemap's lastModified. */
  updated: string;
  /** Where the claims about the other product came from. */
  sources: CompareSource[];
  /** Other comparison slugs. */
  related: string[];
  /** Feature-page slugs this comparison is about. */
  relatedFeatures: string[];
}

export interface ComparePage extends CompareMeta {
  html: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readSources(raw: unknown): CompareSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { label, url } = entry as Record<string, unknown>;
    if (typeof label !== "string" || typeof url !== "string") return [];
    return [{ label, url }];
  });
}

function readStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string") : [];
}

function readComparePage(fileName: string): ComparePage {
  const slug = fileName.replace(/\.md$/, "");
  const source = fs.readFileSync(path.join(COMPARE_DIR, fileName), "utf8");
  const { data, content } = matter(source);
  const fm = data as RawFrontmatter;

  const title = typeof fm.title === "string" ? fm.title : "";
  const description = typeof fm.description === "string" ? fm.description : "";
  const competitor = typeof fm.competitor === "string" ? fm.competitor : "";
  const verdict = typeof fm.verdict === "string" ? fm.verdict : "";
  const updated = typeof fm.updated === "string" ? fm.updated : "";
  const sources = readSources(fm.sources);

  // Throw rather than publish a half-formed page, exactly as the guides
  // loader does. The extra two checks are this section's own rule: a
  // comparison with no sources is an assertion, and one with no "use theirs
  // when" is an advert. Neither is what this directory is for, and neither
  // failure is visible on the rendered page — which is why the build is where
  // it has to be caught.
  if (!title) throw new Error(`content/compare/${fileName}: missing \`title\``);
  if (!description)
    throw new Error(`content/compare/${fileName}: missing \`description\``);
  if (!competitor)
    throw new Error(`content/compare/${fileName}: missing \`competitor\``);
  if (!verdict)
    throw new Error(
      `content/compare/${fileName}: missing \`verdict\` — every comparison has to say when to pick theirs`
    );
  if (sources.length === 0)
    throw new Error(
      `content/compare/${fileName}: no \`sources\` — every claim about somebody else's product needs one`
    );
  if (!ISO_DATE.test(updated))
    throw new Error(
      `content/compare/${fileName}: \`updated\` must be ISO YYYY-MM-DD, got ${JSON.stringify(fm.updated)}`
    );

  return {
    slug,
    title,
    description,
    competitor,
    category: typeof fm.category === "string" ? fm.category : "Alternatives",
    verdict,
    navLabel:
      typeof fm.navLabel === "string" && fm.navLabel ? fm.navLabel : `vs ${competitor}`,
    updated,
    sources,
    related: readStrings(fm.related),
    relatedFeatures: readStrings(fm.relatedFeatures),
    html: marked.parse(content, { async: false }),
  };
}

export function listComparePages(): ComparePage[] {
  if (!fs.existsSync(COMPARE_DIR)) return [];
  return fs
    .readdirSync(COMPARE_DIR)
    .filter((f) => f.endsWith(".md"))
    .map(readComparePage)
    .sort((a, b) => a.competitor.localeCompare(b.competitor));
}

export function getComparePage(slug: string): ComparePage | null {
  return listComparePages().find((c) => c.slug === slug) ?? null;
}

/** Resolve a page's `related` slugs to real pages, dropping any that 404. */
export function relatedComparePages(page: ComparePage): CompareMeta[] {
  const all = listComparePages();
  return page.related
    .map((slug) => all.find((c) => c.slug === slug))
    .filter((c): c is ComparePage => Boolean(c));
}

/** Group the pages for the hub, preserving the order categories first appear. */
export function comparePagesByCategory(): Array<{
  category: string;
  pages: ComparePage[];
}> {
  const groups = new Map<string, ComparePage[]>();
  for (const page of listComparePages()) {
    const existing = groups.get(page.category);
    if (existing) existing.push(page);
    else groups.set(page.category, [page]);
  }
  return [...groups.entries()].map(([category, pages]) => ({ category, pages }));
}

export function formatCompareDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
