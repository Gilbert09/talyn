import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";

/**
 * Guides: technical landing pages at the site root (`/keep-pr-up-to-date`),
 * one per thing somebody actually searches for.
 *
 * Separate from the blog on purpose, and not because of where the files sit.
 * A blog post argues something general and mentions the product at most twice;
 * a guide answers a question the reader typed, and the product is a legitimate
 * part of the answer. Different job, different register, different gate — the
 * blog waits behind BLOG_ENABLED, a guide ships live or not at all, because an
 * unindexed landing page earns nothing.
 *
 * What they are NOT is keyword pages with a paragraph of filler. Each one has
 * to explain the underlying mechanism well enough to be useful to somebody who
 * never installs anything; developers can smell the other kind instantly, and
 * one of those poisons the rest.
 *
 * All reads happen at build time.
 */

const GUIDES_DIR = path.join(process.cwd(), "content", "guides");

interface RawFrontmatter {
  title?: unknown;
  description?: unknown;
  updated?: unknown;
  /** Slugs of other guides to link at the foot. */
  related?: unknown;
}

export interface GuideMeta {
  slug: string;
  title: string;
  description: string;
  /** ISO `YYYY-MM-DD`. Shown, and used as the sitemap's lastModified. */
  updated: string;
  related: string[];
}

export interface Guide extends GuideMeta {
  html: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readGuide(fileName: string): Guide {
  const slug = fileName.replace(/\.md$/, "");
  const source = fs.readFileSync(path.join(GUIDES_DIR, fileName), "utf8");
  const { data, content } = matter(source);
  const fm = data as RawFrontmatter;

  const title = typeof fm.title === "string" ? fm.title : "";
  const description = typeof fm.description === "string" ? fm.description : "";
  const updated = typeof fm.updated === "string" ? fm.updated : "";

  // Throw rather than publish a half-formed page: a guide with no description
  // ships a blank meta description, which is the one field a search result
  // actually renders.
  if (!title) throw new Error(`content/guides/${fileName}: missing \`title\``);
  if (!description) throw new Error(`content/guides/${fileName}: missing \`description\``);
  if (!ISO_DATE.test(updated))
    throw new Error(
      `content/guides/${fileName}: \`updated\` must be ISO YYYY-MM-DD, got ${JSON.stringify(fm.updated)}`
    );

  return {
    slug,
    title,
    description,
    updated,
    related: Array.isArray(fm.related)
      ? fm.related.filter((r): r is string => typeof r === "string")
      : [],
    html: marked.parse(content, { async: false }),
  };
}

export function listGuides(): Guide[] {
  if (!fs.existsSync(GUIDES_DIR)) return [];
  return fs
    .readdirSync(GUIDES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map(readGuide)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getGuide(slug: string): Guide | null {
  return listGuides().find((g) => g.slug === slug) ?? null;
}

/** Resolve a guide's `related` slugs to real guides, dropping any that 404. */
export function relatedGuides(guide: Guide): GuideMeta[] {
  const all = listGuides();
  return guide.related
    .map((slug) => all.find((g) => g.slug === slug))
    .filter((g): g is Guide => Boolean(g));
}

export function formatGuideDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
