import type { Metadata } from "next";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { PageCta } from "@/components/layout/PageCta";
import { FeatureCard } from "@/components/ui/FeatureCard";
import { Reveal } from "@/components/ui/Reveal";
import { WhyTalyn } from "@/components/sections/WhyTalyn";
import { JsonLd, breadcrumbSchema, type Crumb } from "@/components/seo/JsonLd";
import { site } from "@/lib/content";
import { listFeaturePages } from "@/lib/features";
import { listComparePages } from "@/lib/compare";

const title = "Everything Talyn does";
const description =
  "A PR dashboard, AI code review that stays out of your pull request, a merge queue that fixes before it lands, agents on your own subscription, workflows, loops, skills and MCP servers.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/features" },
  openGraph: {
    type: "website",
    title,
    description,
    url: `${site.url}/features`,
  },
};

const crumbs: Crumb[] = [
  { name: "Talyn", href: "/" },
  { name: "Features", href: "/features" },
];

export default function FeaturesHubPage() {
  const features = listFeaturePages();
  const comparisons = listComparePages();

  return (
    <>
      <Nav />
      <main>
        <section className="border-b border-line pb-16 pt-28 sm:pt-32">
          <div className="container">
            <Breadcrumbs crumbs={crumbs} />
            <Reveal className="mt-8 max-w-3xl">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
                Features
              </p>
              <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
                {title}
              </h1>
              <p className="mt-5 text-lg leading-relaxed text-ink-500">
                {description}
              </p>
            </Reveal>
          </div>
        </section>

        <section className="py-20">
          <div className="container">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f, i) => (
                <Reveal key={f.slug} delay={(i % 3) * 0.06}>
                  {/* The kicker is the tagline, not `eyebrow`. Every card
                      here is a feature, so there is no category to announce,
                      and the page's own eyebrow restates the label directly
                      beneath it — "MCP SERVERS / MCP servers". */}
                  <FeatureCard
                    eyebrow={f.tagline}
                    title={f.navLabel}
                    body={f.description}
                    href={`/features/${f.slug}`}
                    className="h-full"
                  />
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* WhyTalyn was written for the homepage and cut from it in Jul 2026
            for restating Features and Providers one section later. On a hub
            page there is nothing above it to restate — this is the standalone
            page the comment in app/page.tsx was holding it for. */}
        <WhyTalyn />

        {comparisons.length > 0 && (
          <section className="border-t border-line py-20">
            <div className="container">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
                How it compares
              </h2>
              <p className="mt-2 max-w-2xl text-ink-500">
                Honest comparisons against the tools people weigh Talyn up
                against, including when you should pick theirs.
              </p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {comparisons.map((c) => (
                  <FeatureCard
                    key={c.slug}
                    eyebrow="Compare"
                    title={`Talyn vs ${c.competitor}`}
                    body={c.verdict}
                    href={`/compare/${c.slug}`}
                    cta="Read the comparison"
                  />
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="pb-24">
          <div className="container">
            <PageCta
              placement="features-hub"
              className="mx-auto max-w-3xl"
              title="Start with the PR list. Everything else follows from it."
              body="Connect GitHub, see every pull request you have open in one place, and send an agent at the first one that is broken. Free for three tasks at a time."
            />
          </div>
        </section>
      </main>
      <Footer />
      <JsonLd data={breadcrumbSchema(crumbs)} />
    </>
  );
}
