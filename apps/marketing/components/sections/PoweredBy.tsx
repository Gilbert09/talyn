import { Reveal } from "@/components/ui/Reveal";
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

        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-3">
          {poweredBy.logos.map((l, i) => (
            <Reveal
              key={l.name}
              delay={i * 0.06}
              className="flex items-center gap-3 rounded-xl border border-line bg-white px-5 py-3 shadow-soft"
            >
              <span className="text-base font-semibold text-ink">{l.name}</span>
              <span className="rounded-full bg-paper-200 px-2 py-0.5 font-mono text-[10px] text-ink-500">
                {l.note}
              </span>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
