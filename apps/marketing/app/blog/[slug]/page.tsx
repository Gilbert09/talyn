import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Prose } from "@/components/ui/Prose";
import { JsonLd, articleSchema } from "@/components/seo/JsonLd";
import { isBlogEnabled } from "@/lib/flags";
import { listPosts, getPost, formatPostDate } from "@/lib/posts";

interface Params {
  params: { slug: string };
}

/**
 * The full set of post URLs, resolved at build time. When the section is
 * gated this returns nothing, so no post page is generated — combined with
 * `dynamicParams = false` below, a guessed URL is an ordinary 404 rather than
 * a page that merely declines to render.
 */
export function generateStaticParams() {
  if (!isBlogEnabled()) return [];
  return listPosts().map((post) => ({ slug: post.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: Params): Metadata {
  const post = isBlogEnabled() ? getPost(params.slug) : null;
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      publishedTime: post.date,
    },
    // A draft only renders in local development, and never wants indexing
    // even there — a crawler that somehow reaches one should not keep it.
    ...(post.draft ? { robots: { index: false, follow: false } } : {}),
  };
}

export default function BlogPostPage({ params }: Params) {
  if (!isBlogEnabled()) notFound();
  const post = getPost(params.slug);
  if (!post) notFound();

  return (
    <>
      <Nav />
      <main className="container max-w-3xl pt-32 pb-24 sm:pt-40">
        <a
          href="/blog"
          className="font-mono text-xs text-clay-600 transition-colors hover:text-clay"
        >
          ← All writing
        </a>

        <h1 className="mt-4 font-display text-4xl font-semibold leading-tight tracking-tight text-ink">
          {post.title}
        </h1>
        <p className="mt-2 text-sm text-ink-400">
          <time dateTime={post.date}>{formatPostDate(post.date)}</time>
          {post.draft && <span className="ml-2 text-clay-600">· draft</span>}
        </p>

        <Prose as="article" className="mt-10" html={post.html} />
      </main>
      <Footer />
      {/* A draft is `noindex` above; emitting schema for one would be telling
          a crawler about a page we have just asked it to forget. */}
      {!post.draft && (
        <JsonLd
          data={articleSchema({
            title: post.title,
            description: post.description,
            path: `/blog/${post.slug}`,
            published: post.date,
          })}
        />
      )}
    </>
  );
}
