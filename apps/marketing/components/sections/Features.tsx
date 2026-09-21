import { Check } from "lucide-react";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { ScreenshotPlaceholder } from "@/components/ui/ScreenshotPlaceholder";
import { features } from "@/lib/content";
import type { MockId } from "@/components/mocks/AppMocks";

/**
 * The subhead used to say "Seven things" as a literal, one line above a map
 * over the array. Counting the array instead means the copy cannot quietly
 * start lying the next time a feature is added or dropped.
 */
const COUNT_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

export function Features() {
  return (
    <section id="features" className="py-20">
      <div className="container">
        <SectionHeading
          kicker="The day job"
          title="The PR busywork, handled."
          sub={`${countWord(features.length)} things Talyn does so you can stay in flow.`}
        />

        <div className="mt-14 space-y-20">
          {features.map((f, i) => {
            // Alternate sides from position, not from a hand-set `flip` field:
            // inserting a feature used to leave two cards on the same side
            // until somebody noticed and re-flipped every one below it.
            const flip = i % 2 === 1;
            return (
            <div
              key={f.id}
              id={f.id}
              className="grid scroll-mt-24 items-center gap-10 lg:grid-cols-2"
            >
              {/* min-w-0 on both grid items — see HowItWorks for the why. */}
              <Reveal className={flip ? "min-w-0 lg:order-2" : "min-w-0"}>
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
                  {f.eyebrow}
                </p>
                <h3 className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
                  {f.title}
                </h3>
                <p className="mt-4 max-w-md text-ink-500">{f.body}</p>
                <ul className="mt-6 space-y-3">
                  {f.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-3 text-sm text-ink-700">
                      <span className="mt-0.5 inline-flex rounded-full border border-clay/30 bg-clay/10 p-0.5">
                        <Check className="h-3.5 w-3.5 text-clay-600" />
                      </span>
                      {b}
                    </li>
                  ))}
                </ul>
              </Reveal>

              <Reveal delay={0.1} className={flip ? "min-w-0 lg:order-1" : "min-w-0"}>
                <ScreenshotPlaceholder shot={f.shot as MockId} filters={false} />
              </Reveal>
            </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
