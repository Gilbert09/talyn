import type { Metadata } from "next";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { PageCta } from "@/components/layout/PageCta";
import { Pricing } from "@/components/sections/Pricing";
import { PlanTable } from "@/components/sections/PlanTable";
import { Teams } from "@/components/sections/Teams";
import { FaqAccordion } from "@/components/sections/FaqAccordion";
import { Reveal } from "@/components/ui/Reveal";
import {
  JsonLd,
  breadcrumbSchema,
  faqSchema,
  type Crumb,
} from "@/components/seo/JsonLd";
import { OfferSchema } from "@/components/seo/OfferSchema";
import { site, pricingFaq } from "@/lib/content";

const title = "Pricing";
const seoTitle = "Talyn pricing — free for 3 tasks, $15/month unlimited";
const description =
  "Talyn is $15 a month, or free with three concurrent tasks, three queued pull requests, three workflows and three loops. Agent runs go on the Claude or ChatGPT subscription you already pay for.";

/**
 * Pricing gets a real page.
 *
 * It was a `#pricing` anchor on the home page, which cost three things: the
 * nav's "Pricing" link threw you back to `/` from any of the 22 sub-pages and
 * dumped you mid-scroll; there was no URL to send anybody; and nothing about
 * the price was reachable without loading the whole home page.
 *
 * The AI-readability side matters as much as the human one for a developer
 * tool. The prices have to be real text in the HTML — which the toggle broke,
 * hence `<PlanTable>` — the plan limits have to be stated in words rather than
 * ticks, the objections have to be extractable, and `Offer` schema has to say
 * both prices. `app/robots.ts` allows every agent, which is what lets any of
 * it be read: blocking `GPTBot` would only opt out of training, while the
 * crawlers that feed AI answers are `OAI-SearchBot`, `Claude-SearchBot` and
 * `PerplexityBot`.
 */
export const metadata: Metadata = {
  title: seoTitle,
  description,
  alternates: { canonical: "/pricing" },
  openGraph: {
    type: "website",
    title: seoTitle,
    description,
    url: `${site.url}/pricing`,
  },
};

const crumbs: Crumb[] = [
  { name: "Talyn", href: "/" },
  { name: "Pricing", href: "/pricing" },
];

export default function PricingPage() {
  return (
    <>
      <Nav />
      <main>
        <section className="pb-4 pt-28 sm:pt-32">
          <div className="container">
            <Breadcrumbs crumbs={crumbs} />
            <Reveal className="mt-8 max-w-3xl">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
                {title}
              </p>
              <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
                One flat price for the control tower.
              </h1>
              <p className="mt-5 text-lg leading-relaxed text-ink-500">
                {description}
              </p>
            </Reveal>
          </div>
        </section>

        {/* The cards, with their monthly/annual toggle. `id="pricing"` rides
            along so an old inbound /#pricing link still lands somewhere. */}
        <Pricing />

        {/* Straight after the per-account price, because that is the
            moment a team lead wonders what four of these cost. */}
        <Teams />

        <PlanTable />

        <section className="py-20">
          <div className="container">
            <h2 className="mx-auto max-w-2xl text-center font-display text-3xl font-semibold tracking-tight text-ink">
              Before you pay
            </h2>
            <FaqAccordion items={pricingFaq} className="mx-auto mt-10 max-w-2xl" />
          </div>
        </section>

        <section className="pb-24">
          <div className="container">
            <PageCta
              placement="pricing-page-footer"
              className="mx-auto max-w-3xl"
              title="The free plan is the whole app."
              body="Three tasks at a time, three pull requests in the queue, and every agent provider. Find out whether it works for you before anybody asks you for a card."
            />
          </div>
        </section>
      </main>
      <Footer />
      <JsonLd data={[breadcrumbSchema(crumbs), faqSchema(pricingFaq)]} />
      <OfferSchema />
    </>
  );
}
