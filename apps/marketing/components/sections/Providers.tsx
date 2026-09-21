import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { GlowCard } from "@/components/ui/GlowCard";
import { ProviderMark } from "@/components/brand/ProviderMarks";
import { providers } from "@/lib/content";

export function Providers() {
  return (
    <section id="providers" className="relative border-t border-line py-24">
      <div className="container">
        <SectionHeading
          kicker={providers.kicker}
          title={providers.title}
          sub={providers.sub}
        />

        <div className="mx-auto mt-14 grid max-w-5xl gap-4 md:grid-cols-3">
          {providers.items.map((p, i) => (
            <Reveal key={p.name} delay={i * 0.08}>
              <GlowCard className="h-full" tone="clay">
                <div className="mb-3 flex items-center gap-3">
                  <span className="inline-flex rounded-xl border border-line bg-paper-100 p-2">
                    <ProviderMark mark={p.mark} className="h-5 w-5 text-clay" />
                  </span>
                  <h3 className="font-display text-lg font-semibold text-ink">
                    {p.name}
                  </h3>
                </div>
                {/* What the agent bills against — the question the old card
                    made a reader infer from a paragraph. */}
                <p className="mb-3 font-mono text-[11px] uppercase tracking-wide text-clay-600">
                  {p.meta}
                </p>
                <p className="text-sm leading-relaxed text-ink-500">{p.body}</p>
              </GlowCard>
            </Reveal>
          ))}
        </div>

        {/* The sandbox claim, once, under the grid: it is true of two of the
            three cards, and repeating it on both would read as filler. */}
        <p className="mx-auto mt-6 max-w-3xl text-center text-sm leading-relaxed text-ink-400">
          {providers.note}
        </p>
      </div>
    </section>
  );
}
