import { Reveal } from "@/components/ui/Reveal";
import { ProviderMark } from "@/components/brand/ProviderMarks";
import { poweredBy } from "@/lib/content";

export function PoweredBy() {
  return (
    <section className="border-y border-line bg-paper-100 py-14">
      <div className="container">
        <Reveal className="mx-auto mb-9 max-w-2xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
            {poweredBy.kicker}
          </p>
          <p className="mt-3 text-ink-500">{poweredBy.blurb}</p>
        </Reveal>

        <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-4">
          {poweredBy.logos.map((l, i) => (
            <Reveal
              key={l.name}
              delay={i * 0.08}
              className="flex items-center gap-3 rounded-2xl border border-line bg-white px-6 py-4 shadow-soft"
            >
              <ProviderMark mark={l.mark} className="h-7 w-7 text-clay" />
              <span className="text-lg font-semibold text-ink">{l.name}</span>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
