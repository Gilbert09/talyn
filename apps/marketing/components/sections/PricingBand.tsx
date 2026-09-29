import { ArrowRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { pricing } from "@/lib/content";

/**
 * Pricing on the home page, in two lines instead of two cards.
 *
 * The full tier comparison lived here and cost 1,158px. Two things retired
 * it. `/pricing` now exists as a real page with the cards, the full limit
 * table and the objections — so the home page no longer has to be the only
 * place a price appears. And the measurement: across thirty days, the pricing
 * CTA on this page produced **zero** download clicks. Every real click came
 * from the nav.
 *
 * So this says the number, says what free means, and gets out of the way. A
 * person who wants to compare tiers is a person willing to click.
 *
 * The prices are read from `pricing.tiers`, never typed here — a home page
 * quoting a stale figure is worse than one quoting none.
 */
export function PricingBand() {
  const [free, paid] = pricing.tiers;

  return (
    <section id="pricing" className="border-t border-line py-16">
      <div className="container">
        <Reveal className="mx-auto max-w-3xl text-center">
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
            {pricing.kicker}
          </p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-ink">
            {free.priceMonthly} to start. {paid.priceMonthly} a month when you
            outgrow it.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-ink-500">
            Free gives you the whole app with three tasks running at once.
            Unlimited removes the caps. Either way the agent runs go on the
            subscription you already pay for.
          </p>
          <a
            href="/pricing"
            className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-clay-600 hover:text-clay"
          >
            See what is in each plan
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </a>
        </Reveal>
      </div>
    </section>
  );
}
