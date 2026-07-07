"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { GlowCard } from "@/components/ui/GlowCard";
import { Badge } from "@/components/ui/badge";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { pricing } from "@/lib/content";
import { cn } from "@/lib/utils";

type Period = "monthly" | "annual";

function PeriodToggle({
  period,
  onChange,
}: {
  period: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <div className="mx-auto mt-8 flex w-fit items-center gap-1 rounded-full border border-line-strong bg-white p-1 shadow-soft">
      {(["monthly", "annual"] as const).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
            period === p ? "bg-clay text-white" : "text-ink-600 hover:text-ink"
          )}
        >
          {p === "monthly" ? "Monthly" : (
            <span className="inline-flex items-center gap-1.5">
              Annual
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  period === "annual" ? "bg-white/20 text-white" : "bg-clay/10 text-clay-600"
                )}
              >
                {pricing.annualBadge}
              </span>
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Pricing() {
  const [period, setPeriod] = useState<Period>("annual");

  return (
    <section id="pricing" className="border-t border-line py-24">
      <div className="container">
        <SectionHeading kicker={pricing.kicker} title={pricing.title} sub={pricing.sub} />
        <PeriodToggle period={period} onChange={setPeriod} />

        <div className="mx-auto mt-10 grid max-w-3xl gap-4 md:grid-cols-2">
          {pricing.tiers.map((tier, i) => (
            <Reveal key={tier.name} delay={i * 0.06}>
              <GlowCard
                tone={tier.highlighted ? "clay" : "plain"}
                className={cn(
                  "flex h-full flex-col p-7",
                  tier.highlighted && "border-clay/40 ring-1 ring-clay/20"
                )}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-lg font-semibold text-ink">
                    {tier.name}
                  </h3>
                  {tier.highlighted && <Badge dot>Recommended</Badge>}
                </div>

                <div className="mt-4 flex items-baseline gap-1.5">
                  <span className="font-display text-4xl font-semibold tracking-tight text-ink">
                    {period === "annual" ? tier.priceAnnual : tier.priceMonthly}
                  </span>
                  <span className="text-sm text-ink-400">{tier.period}</span>
                </div>
                <p className="mt-1 h-4 text-xs text-ink-400">
                  {period === "annual" && tier.periodAnnualNote ? tier.periodAnnualNote : ""}
                </p>

                <p className="mt-3 text-sm text-ink-500">{tier.blurb}</p>

                <ul className="mt-5 space-y-2.5">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-ink-600">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-clay" />
                      {f}
                    </li>
                  ))}
                </ul>

                <div className="mt-auto pt-7">
                  <DownloadButton
                    size="md"
                    className="w-full"
                    variant={tier.highlighted ? "primary" : "secondary"}
                  >
                    {tier.cta}
                  </DownloadButton>
                </div>
              </GlowCard>
            </Reveal>
          ))}
        </div>

        <Reveal className="mx-auto mt-8 max-w-2xl text-center">
          <p className="text-xs leading-relaxed text-ink-400">{pricing.footnote}</p>
        </Reveal>
      </div>
    </section>
  );
}
