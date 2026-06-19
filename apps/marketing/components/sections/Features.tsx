import { Check } from "lucide-react";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { ScreenshotPlaceholder } from "@/components/ui/ScreenshotPlaceholder";
import { features } from "@/lib/content";
import type { MockId } from "@/components/mocks/AppMocks";

export function Features() {
  return (
    <section id="features" className="py-24">
      <div className="container">
        <SectionHeading
          kicker="Features"
          title="The PR busywork, handled."
          sub="Four things Talyn does so you can stay in flow."
        />

        <div className="mt-16 space-y-24">
          {features.map((f) => (
            <div key={f.id} className="grid items-center gap-10 lg:grid-cols-2">
              <Reveal className={f.flip ? "lg:order-2" : ""}>
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-talon-300">
                  {f.eyebrow}
                </p>
                <h3 className="mt-3 font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  {f.title}
                </h3>
                <p className="mt-4 max-w-md text-owl-50/60">{f.body}</p>
                <ul className="mt-6 space-y-3">
                  {f.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-3 text-sm text-owl-50/80">
                      <span className="mt-0.5 inline-flex rounded-full border border-talon/30 bg-talon/10 p-0.5">
                        <Check className="h-3.5 w-3.5 text-talon-300" />
                      </span>
                      {b}
                    </li>
                  ))}
                </ul>
              </Reveal>

              <Reveal delay={0.1} className={f.flip ? "lg:order-1" : ""}>
                <ScreenshotPlaceholder shot={f.shot as MockId} />
              </Reveal>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
