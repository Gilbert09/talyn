import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import { areDraftsVisible } from "@/lib/flags";

/**
 * The blog's content layer: markdown files committed next to the site.
 *
 * Posts are files rather than rows in a CMS because the whole point of this
 * section is engineering write-ups that quote real code and real numbers —
 * they are drafted, reviewed and corrected in the same way the code is, and a
 * post that contradicts the product should be fixable in the same pull
 * request that changes it.
 *
 * Every read happens at build time. Nothing here runs per request.
 */

const POSTS_DIR = path.join(process.cwd(), "content", "posts");

/** Frontmatter as authored, before defaults are applied. */
interface RawFrontmatter {
  title?: unknown;
  description?: unknown;
  date?: unknown;
  draft?: unknown;
  tags?: unknown;
}

export interface PostMeta {
  slug: string;
  title: string;
  /** Used as the meta description and the index-page standfirst. */
  description: string;
  /** ISO `YYYY-MM-DD`. Sort key and the only date the page displays. */
  date: string;
  draft: boolean;
  tags: string[];
}

export interface Post extends PostMeta {
  /** Rendered markdown. Trusted input: these files live in this repository. */
  html: string;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asTags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read and validate one post. Throws rather than rendering a broken page: a
 * missing title or an unparseable date is a mistake to fix before the build
 * finishes, not something to paper over with "Untitled" on a public URL.
 */
function readPost(fileName: string): Post {
  const slug = fileName.replace(/\.md$/, "");
  const source = fs.readFileSync(path.join(POSTS_DIR, fileName), "utf8");
  const { data, content } = matter(source);
  const fm = data as RawFrontmatter;

  const title = asString(fm.title);
  const description = asString(fm.description);
  const date = asString(fm.date);

  if (!title) throw new Error(`content/posts/${fileName}: frontmatter is missing \`title\``);
  if (!description)
    throw new Error(`content/posts/${fileName}: frontmatter is missing \`description\``);
  if (!ISO_DATE.test(date))
    throw new Error(
      `content/posts/${fileName}: \`date\` must be an ISO YYYY-MM-DD string, got ${JSON.stringify(fm.date)}`
    );

  return {
    slug,
    title,
    description,
    date,
    // Anything but an explicit `false` is a draft. A post is unfinished until
    // somebody says it is not, which is the same direction as the section gate.
    draft: fm.draft !== false,
    tags: asTags(fm.tags),
    html: marked.parse(content, { async: false }),
  };
}

/** Every post that may be shown here, newest first. */
export function listPosts(): Post[] {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const showDrafts = areDraftsVisible();
  return fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map(readPost)
    .filter((p) => showDrafts || !p.draft)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** One post by slug, or null when it does not exist or is a hidden draft. */
export function getPost(slug: string): Post | null {
  return listPosts().find((p) => p.slug === slug) ?? null;
}

/** Long-form date for display, e.g. "16 September 2026". */
export function formatPostDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
