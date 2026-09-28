import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { PageCta } from "@/components/layout/PageCta";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { FeatureCard } from "@/components/ui/FeatureCard";
import { WebAppButton } from "@/components/ui/WebAppButton";
import { Reveal } from "@/components/ui/Reveal";
import { ScreenshotPlaceholder } from "@/components/ui/ScreenshotPlaceholder";
import { FaqAccordion } from "@/components/sections/FaqAccordion";
import {
  JsonLd,
  breadcrumbSchema,
  faqSchema,
  type Crumb,
} from "@/components/seo/JsonLd";
import { site } from "@/lib/content";
import {
  listFeaturePages,
  getFeaturePage,
  relatedFeaturePages,
  type FeatureSection,
} from "@/lib/features";
import { listGuides } from "@/lib/guides";
import { listComparePages } from "@/lib/compare";

/**
 * One template, ten pages. `dynamicParams = false` means only the slugs in
 * `lib/features.ts` exist and anything else is an ordinary 404 — the same
 * property the guides route relies on at the site root.
 */
export function generateStaticParams() {
  return listFeaturePages().map((f) => ({ slug: f.slug }));
}

export const dynamicParams = false;

interface Params {
  params: { slug: string };
}

export function generateMetadata({ params }: Params): Metadata {
  const feature = getFeaturePage(params.slug);
  if (!feature) return {};
  return {
    title: feature.seoTitle,
    description: feature.description,
    // Explicit on every page. The root deliberately carries none — see the
    // long note in app/layout.tsx on why a missing canonical is safe and an
    // inherited one is not.
    alternates: { canonical: `/features/${feature.slug}` },
    openGraph: {
      type: "article",
      title: feature.seoTitle,
      description: feature.description,
      url: `${site.url}/features/${feature.slug}`,
      modifiedTime: feature.updated,
    },
  };
}

export default function FeaturePageRoute({ params }: Params) {
  const feature = getFeaturePage(params.slug);
  if (!feature) notFound();

  const crumbs: Crumb[] = [
    { name: "Talyn", href: "/" },
    { name: "Features", href: "/features" },
    { name: feature.navLabel, href: `/features/${feature.slug}` },
  ];

  const siblings = relatedFeaturePages(feature);
  const guides = listGuides().filter((g) =>
    (feature.relatedGuides ?? []).includes(g.slug)
  );
  const comparisons = listComparePages().filter((c) =>
    (feature.relatedCompare ?? []).includes(c.slug)
  );

  return (
    <>
      <Nav />
      <main>
        {/* Hero. pt-32 clears the fixed nav, matching the guide pages. */}
        <section className="border-b border-line pb-16 pt-28 sm:pt-32">
          <div className="container">
            <Breadcrumbs crumbs={crumbs} />

            <div className="mt-8 grid items-center gap-10 lg:grid-cols-2">
              {/* min-w-0 on both, or the mock's intrinsic width blows the grid
                  out at laptop sizes. Same note as HowItWorks. */}
              <Reveal className="min-w-0">
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
                  {feature.eyebrow}
                </p>
                <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
                  {feature.title}
                </h1>
                <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-500">
                  {feature.description}
                </p>

                <ul className="mt-7 space-y-3">
                  {feature.bullets.map((b) => (
                    <li
                      key={b}
                      className="flex items-start gap-3 text-sm text-ink-700"
                    >
                      <span className="mt-0.5 inline-flex rounded-full border border-clay/30 bg-clay/10 p-0.5">
                        <Check className="h-3.5 w-3.5 text-clay-600" />
                      </span>
                      {b}
                    </li>
                  ))}
                </ul>

                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <DownloadButton
                    size="md"
                    placement={`feature-${feature.slug}-hero`}
                  />
                  <WebAppButton
                    size="md"
                    placement={`feature-${feature.slug}-hero`}
                  />
                </div>

                {feature.planNote && (
                  <p className="mt-5 max-w-lg text-xs leading-relaxed text-ink-400">
                    {feature.planNote}
                  </p>
                )}
              </Reveal>

              <Reveal delay={0.1} className="min-w-0">
                <ScreenshotPlaceholder
                  shot={feature.heroMock}
                  filters={false}
                  title={`Talyn — ${feature.navLabel}`}
                />
              </Reveal>
            </div>
          </div>
        </section>

        {/* Body. Alternating sides where a section carries a mock; full width
            where it does not, because a lone column of text in a half-grid
            reads as a rendering bug. */}
        <section className="py-20">
          <div className="container space-y-16">
            {feature.sections.map((s, i) =>
              s.mock ? (
                <div
                  key={s.heading}
                  className="grid items-center gap-10 lg:grid-cols-2"
                >
                  <Reveal className={i % 2 === 1 ? "min-w-0 lg:order-2" : "min-w-0"}>
                    <SectionBody section={s} />
                  </Reveal>
                  <Reveal
                    delay={0.1}
                    className={i % 2 === 1 ? "min-w-0 lg:order-1" : "min-w-0"}
                  >
                    <ScreenshotPlaceholder shot={s.mock} filters={false} />
                  </Reveal>
                </div>
              ) : (
                <Reveal key={s.heading} className="max-w-3xl">
                  <SectionBody section={s} />
                </Reveal>
              )
            )}
          </div>
        </section>

        {feature.faq.length > 0 && (
          <section className="border-t border-line bg-paper-100 py-20">
            <div className="container">
              {/* Not "Questions about {navLabel}" — lowercasing a label
                  written for a nav column gives "pr dashboard" and "mcp
                  servers", and leaving the case alone gives "Questions about
                  Merge queue". The homepage's heading is right here too. */}
              <h2 className="mx-auto max-w-2xl text-center font-display text-3xl font-semibold tracking-tight text-ink">
                Questions, answered.
              </h2>
              <FaqAccordion
                items={feature.faq}
                className="mx-auto mt-10 max-w-2xl"
              />
            </div>
          </section>
        )}

        <section className="py-20">
          <div className="container">
            <PageCta
              placement={`feature-${feature.slug}-footer`}
              className="mx-auto max-w-3xl"
            />

            {(siblings.length > 0 ||
              guides.length > 0 ||
              comparisons.length > 0) && (
              <div className="mx-auto mt-14 max-w-5xl">
                <h2 className="font-display text-xl font-semibold text-ink">
                  Keep reading
                </h2>
                <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {/* "Feature", not the page's own eyebrow, which restates
                      the label under it. These cards sit beside Compare and
                      Guide ones, so the kicker is earning its place by
                      saying what KIND of link this is. */}
                  {siblings.map((s) => (
                    <FeatureCard
                      key={s.slug}
                      eyebrow="Feature"
                      title={s.navLabel}
                      body={s.tagline}
                      href={`/features/${s.slug}`}
                    />
                  ))}
                  {comparisons.map((c) => (
                    <FeatureCard
                      key={c.slug}
                      eyebrow="Compare"
                      title={`Talyn vs ${c.competitor}`}
                      body={c.description}
                      href={`/compare/${c.slug}`}
                      cta="Read the comparison"
                    />
                  ))}
                  {guides.map((g) => (
                    <FeatureCard
                      key={g.slug}
                      eyebrow="Guide"
                      title={g.navLabel}
                      body={g.description}
                      href={`/${g.slug}`}
                      cta="Read the guide"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
      <Footer />
      <JsonLd
        data={[breadcrumbSchema(crumbs), ...(feature.faq.length ? [faqSchema(feature.faq)] : [])]}
      />
    </>
  );
}

function SectionBody({ section }: { section: FeatureSection }) {
  return (
    <>
      <h2 className="font-display text-2xl font-semibold leading-snug tracking-tight text-ink sm:text-3xl">
        {section.heading}
      </h2>
      <div className="mt-4 space-y-4">
        {section.paragraphs.map((p) => (
          <p key={p} className="text-[15px] leading-relaxed text-ink-500">
            {p}
          </p>
        ))}
      </div>
      {section.bullets && (
        <ul className="mt-6 space-y-3">
          {section.bullets.map((b) => (
            <li key={b} className="flex items-start gap-3 text-sm text-ink-700">
              <span className="mt-0.5 inline-flex rounded-full border border-clay/30 bg-clay/10 p-0.5">
                <Check className="h-3.5 w-3.5 text-clay-600" />
              </span>
              {b}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
