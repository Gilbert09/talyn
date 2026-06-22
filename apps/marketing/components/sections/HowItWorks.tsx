import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { ScreenshotPlaceholder } from "@/components/ui/ScreenshotPlaceholder";
import { how } from "@/lib/content";
import type { MockId } from "@/components/mocks/AppMocks";

export function HowItWorks() {
  return (
    <section id="how" className="relative border-t border-line bg-paper-100 py-24">
      <div className="container">
        <SectionHeading kicker={how.kicker} title={how.title} sub={how.sub} />

        <div className="mt-16 space-y-20">
          {how.steps.map((step, i) => {
            const flip = i % 2 === 1;
            return (
              <div key={step.n} className="grid items-center gap-10 lg:grid-cols-5">
                <Reveal className={flip ? "lg:order-2 lg:col-span-2" : "lg:col-span-2"}>
                  <div className="flex items-center gap-3">
                    <span className="font-display text-5xl font-semibold text-clay/20">
                      {step.n}
                    </span>
                    <span className="h-px flex-1 bg-gradient-to-r from-clay/40 to-transparent" />
                  </div>
                  <h3 className="mt-4 font-display text-2xl font-semibold text-ink">
                    {step.title}
                  </h3>
                  <p className="mt-3 max-w-md text-ink-500">{step.body}</p>
                </Reveal>

                <Reveal
                  delay={0.1}
                  className={flip ? "lg:order-1 lg:col-span-3" : "lg:col-span-3"}
                >
                  <ScreenshotPlaceholder shot={step.shot as MockId} glow={false} />
                </Reveal>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
