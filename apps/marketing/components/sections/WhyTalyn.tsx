import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { GlowCard } from "@/components/ui/GlowCard";
import { why } from "@/lib/content";

export function WhyTalyn() {
  return (
    <section className="border-t border-line bg-paper-100 py-24">
      <div className="container">
        <SectionHeading kicker={why.kicker} title={why.title} />

        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {why.cards.map((c, i) => (
            <Reveal key={c.title} delay={(i % 3) * 0.06}>
              <GlowCard className="h-full" tone="clay">
                <div className="mb-3 h-1 w-10 rounded-full bg-clay" />
                <h3 className="font-display text-lg font-semibold text-ink">
                  {c.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{c.body}</p>
              </GlowCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
