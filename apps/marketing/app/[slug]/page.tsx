import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { Button } from "@/components/ui/button";
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
          dangerouslySetInnerHTML={{ __html: guide.html }}
        />

        {/* One CTA, at the end, after the page has been useful. A reader who
            bounced at the top was never going to download anything. */}
        <div className="mt-14 rounded-2xl border border-line bg-paper-100 p-6">
          <p className="font-display text-lg font-semibold text-ink">
            Talyn does this for you.
          </p>
          <p className="mt-1.5 text-[15px] leading-relaxed text-ink-500">
            Mission control for your GitHub pull requests, running on the Claude or
            ChatGPT subscription you already pay for. Free for three tasks at a time.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <DownloadButton size="md" placement="landing-page" />
            <a href={site.appUrl}>
              <Button variant="secondary" size="md">
                Open in browser
              </Button>
            </a>
          </div>
        </div>

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
    </>
  );
}
