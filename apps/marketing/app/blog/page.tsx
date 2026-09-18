import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { isBlogEnabled } from "@/lib/flags";
import { listPosts, formatPostDate } from "@/lib/posts";
import { site } from "@/lib/content";

/**
 * Metadata is resolved even when the page below calls `notFound()`, so a
 * static `metadata` export served the 404 a `<title>Writing · Talyn</title>`
 * and a description of a section that does not exist yet. Harmless, and still
 * the wrong answer: a gated route should look like an absent one.
 */
export function generateMetadata(): Metadata {
  if (!isBlogEnabled()) return {};
  return {
    title: "Writing",
    description:
      "Engineering write-ups from building Talyn — running agents against real credentials, scheduling on disposable infrastructure, and the failures that look like successes.",
    alternates: { canonical: "/blog" },
  };
}

export default function BlogIndexPage() {
  // The gate is checked here as well as in the sitemap, the feed and the nav.
  // Each surface can leak a URL on its own, so each one asks.
  if (!isBlogEnabled()) notFound();

  const posts = listPosts();

  return (
    <>
      <Nav />
      <main className="container max-w-3xl pt-32 pb-24 sm:pt-40">
        <h1 className="font-display text-4xl font-semibold tracking-tight text-ink">
          Writing
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-600">
          Notes from building {site.name}. Mostly about running coding agents
          somewhere they cannot hurt you, and the things that turned out not to
          work.
        </p>

        {posts.length === 0 ? (
          <p className="mt-12 text-[15px] text-ink-400">Nothing published yet.</p>
        ) : (
          <ul className="mt-12 space-y-10">
            {posts.map((post) => (
              <li key={post.slug}>
                <a href={`/blog/${post.slug}`} className="group block">
                  <time
                    dateTime={post.date}
                    className="font-mono text-xs text-ink-400"
                  >
                    {formatPostDate(post.date)}
                  </time>
                  <h2 className="mt-1 font-display text-xl font-semibold text-ink transition-colors group-hover:text-clay">
                    {post.title}
                    {post.draft && (
                      <span className="ml-2 align-middle font-mono text-[10px] uppercase tracking-wide text-clay-600">
                        draft
                      </span>
                    )}
                  </h2>
                  <p className="mt-1.5 text-[15px] leading-relaxed text-ink-600">
                    {post.description}
                  </p>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
      <Footer />
    </>
  );
}
