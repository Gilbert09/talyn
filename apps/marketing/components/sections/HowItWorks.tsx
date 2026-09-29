import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { how } from "@/lib/content";

/**
 * Three steps, three columns.
 *
 * This was three full-width alternating rows, each with a product mock —
 * 1,738px, the second-largest section on the page, to say something that fits
 * in three short paragraphs. The mocks were the cost: each one forced a
 * two-column row and a lot of vertical space to sit in.
 *
 * They are not missed here. The hero already shows the dashboard at full
 * size, the feature pages show every mock in context, and a reader on a
 * "how does this work" section wants the shape of the thing in ten seconds —
 * connect, watch, delegate — not three more screenshots.
 */
export function HowItWorks() {
  return (
    <section id="how" className="relative border-t border-line bg-paper-100 py-20">
      <div className="container">
        <SectionHeading kicker={how.kicker} title={how.title} sub={how.sub} />

        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {how.steps.map((step, i) => (
            <Reveal key={step.n} delay={i * 0.08} className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="font-display text-4xl font-semibold text-clay/25">
                  {step.n}
                </span>
                <span className="h-px flex-1 bg-gradient-to-r from-clay/40 to-transparent" />
              </div>
              <h3 className="mt-4 font-display text-xl font-semibold text-ink">
                {step.title}
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-500">
                {step.body}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
