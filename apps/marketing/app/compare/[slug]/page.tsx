import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { PageCta } from "@/components/layout/PageCta";
import { Prose } from "@/components/ui/Prose";
import { FeatureCard } from "@/components/ui/FeatureCard";
import {
  JsonLd,
  breadcrumbSchema,
  articleSchema,
  type Crumb,
} from "@/components/seo/JsonLd";
import { site } from "@/lib/content";
import {
  listComparePages,
  getComparePage,
  relatedComparePages,
  formatCompareDate,
} from "@/lib/compare";
import { getFeaturePage } from "@/lib/features";

export function generateStaticParams() {
  return listComparePages().map((c) => ({ slug: c.slug }));
}

export const dynamicParams = false;

interface Params {
  params: { slug: string };
}

export function generateMetadata({ params }: Params): Metadata {
  const page = getComparePage(params.slug);
  if (!page) return {};
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: `/compare/${page.slug}` },
    openGraph: {
      type: "article",
      title: page.title,
      description: page.description,
      url: `${site.url}/compare/${page.slug}`,
      modifiedTime: page.updated,
    },
  };
}

export default function ComparePageRoute({ params }: Params) {
  const page = getComparePage(params.slug);
  if (!page) notFound();

  const crumbs: Crumb[] = [
    { name: "Talyn", href: "/" },
    { name: "Compare", href: "/compare" },
    { name: page.navLabel, href: `/compare/${page.slug}` },
  ];

  const siblings = relatedComparePages(page);
  const features = page.relatedFeatures
    .map((slug) => getFeaturePage(slug))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));

  return (
    <>
      <Nav />
      <main className="container max-w-3xl pb-24 pt-28 sm:pt-32">
        <Breadcrumbs crumbs={crumbs} />

        <h1 className="mt-8 font-display text-4xl font-semibold leading-tight tracking-tight text-ink">
          {page.title}
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-600">
          {page.description}
        </p>
        <p className="mt-3 text-sm text-ink-400">
          Checked{" "}
          <time dateTime={page.updated}>{formatCompareDate(page.updated)}</time>
        </p>

        {/* The verdict goes above the fold, not at the bottom. A comparison
            page that makes you scroll to find out when the other product is
            the right answer has already told you it is not going to say so. */}
        <div className="mt-8 rounded-2xl border border-clay/25 bg-clay/[0.06] p-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-clay-600">
            Use {page.competitor} instead when
          </p>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-700">
            {page.verdict}
          </p>
        </div>

        <Prose as="article" className="mt-10" html={page.html} />

        <div className="mt-12 border-t border-line pt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Sources
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-500">
            Everything this page says about {page.competitor} was read from
            their own documentation on{" "}
            <time dateTime={page.updated}>{formatCompareDate(page.updated)}</time>.
            Products change; if something here is out of date, tell us and we
            will fix it.
          </p>
          <ul className="mt-3 space-y-2">
            {page.sources.map((s) => (
              <li key={s.url}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer nofollow"
                  className="inline-flex items-center gap-1.5 text-[15px] text-clay-600 underline underline-offset-2"
                >
                  {s.label}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
            ))}
          </ul>
        </div>

        <PageCta placement={`compare-${page.slug}`} />

        {(features.length > 0 || siblings.length > 0) && (
          <div className="mt-12 border-t border-line pt-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Related
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {features.map((f) => (
                <FeatureCard
                  key={f.slug}
                  eyebrow={f.eyebrow}
                  title={f.navLabel}
                  body={f.description}
                  href={`/features/${f.slug}`}
                />
              ))}
              {siblings.map((s) => (
                <FeatureCard
                  key={s.slug}
                  eyebrow="Compare"
                  title={`Talyn vs ${s.competitor}`}
                  body={s.verdict}
                  href={`/compare/${s.slug}`}
                  cta="Read the comparison"
                />
              ))}
            </div>
          </div>
        )}
      </main>
      <Footer />
      <JsonLd
        data={[
          breadcrumbSchema(crumbs),
          articleSchema({
            title: page.title,
            description: page.description,
            path: `/compare/${page.slug}`,
            modified: page.updated,
          }),
        ]}
      />
    </>
  );
}
