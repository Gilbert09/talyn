import { Marquee } from "@/components/ui/Marquee";
import { Reveal } from "@/components/ui/Reveal";
import { poweredBy } from "@/lib/content";

export function PoweredBy() {
  return (
    <section className="border-y border-white/[0.05] bg-ink-900/40 py-14">
      <div className="container">
        <Reveal className="mx-auto mb-9 max-w-2xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-talon-300">
            {poweredBy.kicker}
          </p>
          <p className="mt-3 text-owl-50/60">{poweredBy.blurb}</p>
        </Reveal>

        <Marquee>
          {poweredBy.logos.map((l) => (
            <div
              key={l.name}
              className="flex items-center gap-3 whitespace-nowrap rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-3"
            >
              <span className="text-base font-semibold text-owl-50/85">{l.name}</span>
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-owl-50/45">
                {l.note}
              </span>
            </div>
          ))}
        </Marquee>
      </div>
    </section>
  );
}
