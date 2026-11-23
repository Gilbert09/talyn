import { Cloud, GitMerge, KeyRound } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { reasons } from "@/lib/content";

const ICONS = { cloud: Cloud, key: KeyRound, merge: GitMerge } as const;

/**
 * Why Talyn, in three lines, straight under the hero.
 *
 * The median visitor does not scroll, so the reasons to use the product have
 * to sit next to the first screen. Each competitor owns one or two of these;
 * none says all three (research, 2026-11-12).
 */
export function Reasons() {
  return (
    <section className="border-t border-line py-14">
      <div className="container">
        <div className="mx-auto grid max-w-5xl gap-8 sm:grid-cols-3">
          {reasons.map((r, i) => {
            const Icon = ICONS[r.icon];
            return (
              <Reveal key={r.title} delay={i * 0.06}>
                <span className="inline-flex rounded-xl border border-line bg-paper-100 p-2">
                  <Icon className="h-5 w-5 text-clay" />
                </span>
                <h2 className="mt-3 font-display text-lg font-semibold text-ink">{r.title}</h2>
                <p className="mt-1.5 text-[15px] leading-relaxed text-ink-500">{r.body}</p>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
