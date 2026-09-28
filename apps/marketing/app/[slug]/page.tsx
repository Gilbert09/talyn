import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { PageCta } from "@/components/layout/PageCta";
import { Prose } from "@/components/ui/Prose";
import { JsonLd, articleSchema } from "@/components/seo/JsonLd";
import { site } from "@/lib/content";
import { listGuides, getGuide, relatedGuides, formatGuideDate } from "@/lib/guides";

/**
 * Guides live at the site root, because that is where their URL reads best:
 * /keep-pr-up-to-date, not /guides/keep-pr-up-to-date.
 *
 * A root dynamic segment sounds alarming next to /privacy and /blog, and is
 * not: Next resolves static segments before dynamic ones, so those keep
 * winning. `dynamicParams = false` then means only the slugs generated below
 * exist and every other path is an ordinary 404 — this route cannot start
 * answering for URLs nobody wrote.
 */
export function generateStaticParams() {
  return listGuides().map((g) => ({ slug: g.slug }));
}

export const dynamicParams = false;

interface Params {
  params: { slug: string };
}

export function generateMetadata({ params }: Params): Metadata {
  const guide = getGuide(params.slug);
  if (!guide) return {};
  return {
    title: guide.title,
    description: guide.description,
    // Set explicitly on every page. See app/layout.tsx on why the root no
    // longer carries one.
    alternates: { canonical: `/${guide.slug}` },
    openGraph: {
      type: "article",
      title: guide.title,
      description: guide.description,
      url: `${site.url}/${guide.slug}`,
      modifiedTime: guide.updated,
    },
  };
}

export default function GuidePage({ params }: Params) {
  const guide = getGuide(params.slug);
  if (!guide) notFound();

  const related = relatedGuides(guide);

  return (
    <>
      <Nav />
      <main className="container max-w-3xl pt-32 pb-24 sm:pt-40">
        <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-ink">
          {guide.title}
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-600">{guide.description}</p>
        <p className="mt-3 text-sm text-ink-400">
          Last updated <time dateTime={guide.updated}>{formatGuideDate(guide.updated)}</time>
        </p>

        <Prose as="article" className="mt-10" html={guide.html} />

        {/* One CTA, at the end, after the page has been useful. A reader who
            bounced at the top was never going to download anything. */}
        <PageCta placement="landing-page" />

        {related.length > 0 && (
          <nav className="mt-12 border-t border-line pt-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Related
            </p>
            <ul className="mt-3 space-y-2">
              {related.map((r) => (
                <li key={r.slug}>
                  <a
                    href={`/${r.slug}`}
                    className="text-[15px] text-clay-600 underline underline-offset-2"
                  >
                    {r.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </main>
      <Footer />
      <JsonLd
        data={articleSchema({
          title: guide.title,
          description: guide.description,
          path: `/${guide.slug}`,
          modified: guide.updated,
        })}
      />
    </>
  );
}
