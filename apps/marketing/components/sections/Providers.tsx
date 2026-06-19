import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { GlowCard } from "@/components/ui/GlowCard";
import { providers } from "@/lib/content";
import { cn } from "@/lib/utils";

const statusTone: Record<string, string> = {
  Live: "border-status-green/30 bg-status-green/10 text-status-green",
  "Coming soon": "border-owl-400/30 bg-owl-400/10 text-owl-200",
};

export function Providers() {
  return (
    <section
      id="providers"
      className="relative border-t border-white/[0.05] bg-ink-900/30 py-24"
    >
      <div className="container">
        <SectionHeading
          kicker={providers.kicker}
          title={providers.title}
          sub={providers.sub}
        />

        <div className="mx-auto mt-14 grid max-w-5xl gap-4 md:grid-cols-3">
          {providers.items.map((p, i) => (
            <Reveal key={p.name} delay={i * 0.08}>
              <GlowCard className="h-full" tone={p.status === "Live" ? "blue" : "talon"}>
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-lg font-semibold text-white">
                    {p.name}
                  </h3>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                      statusTone[p.status]
                    )}
                  >
                    {p.status}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-owl-50/40">{p.sub}</p>
                <p className="mt-4 text-sm leading-relaxed text-owl-50/60">{p.body}</p>
              </GlowCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
