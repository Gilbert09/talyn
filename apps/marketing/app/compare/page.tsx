import type { Metadata } from "next";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { PageCta } from "@/components/layout/PageCta";
import { FeatureCard } from "@/components/ui/FeatureCard";
import { Reveal } from "@/components/ui/Reveal";
import { JsonLd, breadcrumbSchema, type Crumb } from "@/components/seo/JsonLd";
import { site } from "@/lib/content";
import { comparePagesByCategory } from "@/lib/compare";
import { getGuide } from "@/lib/guides";

const title = "Talyn vs the alternatives";
const description =
  "Honest comparisons against the AI review tools, merge queues, cloud coding agents and PR dashboards people weigh Talyn up against — including when you should pick theirs.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/compare" },
  openGraph: {
    type: "website",
    title,
    description,
    url: `${site.url}/compare`,
  },
};

const crumbs: Crumb[] = [
  { name: "Talyn", href: "/" },
  { name: "Compare", href: "/compare" },
];

export default function CompareHubPage() {
  const groups = comparePagesByCategory();

  // The GitHub merge queue comparison predates this section and lives at the
  // site root, where it is indexed. Moving it would trade an earning URL for
  // a tidier tree, so it is linked from here instead.
  const mergeQueueGuide = getGuide("github-merge-queue-alternative");

  return (
    <>
      <Nav />
      <main>
        <section className="border-b border-line pb-16 pt-28 sm:pt-32">
          <div className="container">
            <Breadcrumbs crumbs={crumbs} />
            <Reveal className="mt-8 max-w-3xl">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
                Compare
              </p>
              <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
                {title}
              </h1>
              <p className="mt-5 text-lg leading-relaxed text-ink-500">
                {description}
              </p>
              <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-400">
                Every page here states what Talyn does not do, cites where its
                claims about the other product came from, and says plainly when
                the other product is the better answer. Several of these tools
                are very good and some of them solve a problem Talyn does not
                try to.
              </p>
            </Reveal>
          </div>
        </section>

        <section className="py-20">
          <div className="container space-y-14">
            {groups.map((group) => (
              <div key={group.category}>
                <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
                  {group.category}
                </h2>
                <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {/* No eyebrow: the title already reads "Talyn vs X", so
                      "VS X" above it is the same words twice, and the
                      category heading directly above the grid has already
                      said which group this is. */}
                  {group.pages.map((p, i) => (
                    <Reveal key={p.slug} delay={(i % 3) * 0.06}>
                      <FeatureCard
                        title={p.title}
                        body={p.description}
                        href={`/compare/${p.slug}`}
                        cta="Read the comparison"
                        className="h-full"
                      />
                    </Reveal>
                  ))}
                  {group.category === "Merge queues" && mergeQueueGuide && (
                    <Reveal delay={0.12}>
                      <FeatureCard
                        title={mergeQueueGuide.title}
                        body={mergeQueueGuide.description}
                        href={`/${mergeQueueGuide.slug}`}
                        cta="Read the comparison"
                        className="h-full"
                      />
                    </Reveal>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="pb-24">
          <div className="container">
            <PageCta
              placement="compare-hub"
              className="mx-auto max-w-3xl"
              title="The quickest comparison is the one you run yourself."
              body="Connect GitHub, point Talyn at a pull request that is broken, and see what comes back. Free for three tasks at a time, on the agent subscription you already pay for."
            />
          </div>
        </section>
      </main>
      <Footer />
      <JsonLd data={breadcrumbSchema(crumbs)} />
    </>
  );
}
