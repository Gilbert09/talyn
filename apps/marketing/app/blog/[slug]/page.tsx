import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
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

        <article
          className="
            mt-10 space-y-5 text-ink-600 leading-relaxed
            [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-ink
            [&_h3]:mt-8 [&_h3]:font-display [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-ink
            [&_p]:text-[15px]
            [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_ul]:text-[15px]
            [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_ol]:text-[15px]
            [&_a]:text-clay-600 [&_a]:underline [&_a]:underline-offset-2
            [&_strong]:font-semibold [&_strong]:text-ink
            [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-ink-400
            [&_code]:rounded [&_code]:bg-ink/[0.05] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px]
            [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:bg-ink/[0.03] [&_pre]:p-4
            [&_pre_code]:bg-transparent [&_pre_code]:p-0
            [&_table]:block [&_table]:overflow-x-auto [&_table]:text-[14px]
            [&_th]:border-b [&_th]:border-line [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:text-ink
            [&_td]:border-b [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_td]:align-top
          "
          dangerouslySetInnerHTML={{ __html: post.html }}
        />
      </main>
      <Footer />
    </>
  );
}
