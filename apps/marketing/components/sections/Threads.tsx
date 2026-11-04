import { ArrowRight, Check } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { ScreenshotPlaceholder } from "@/components/ui/ScreenshotPlaceholder";
import { threads } from "@/lib/content";

/** Threads: one conversation that runs sessions across repositories. */
export function Threads() {
  return (
    <section id="threads" className="scroll-mt-20 border-t border-line py-24">
      <div className="container grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Reveal className="min-w-0">
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
            {threads.kicker}
          </p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            {threads.title}
          </h2>
          <p className="mt-4 text-lg text-ink-500">{threads.sub}</p>
          <ul className="mt-6 space-y-2.5">
            {threads.bullets.map((b) => (
              <li key={b} className="flex gap-2.5 text-sm leading-relaxed text-ink-600">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-clay" />
                {b}
              </li>
            ))}
          </ul>
          <a
            href="/features/threads"
            className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-clay-600 hover:text-clay"
          >
            {threads.link}
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </a>
        </Reveal>

        <Reveal delay={0.1} className="min-w-0">
          <ScreenshotPlaceholder
            shot="thread"
            title="Talyn · Usage billing rollout"
            glow={false}
            filters={false}
          />
        </Reveal>
      </div>
    </section>
  );
}
