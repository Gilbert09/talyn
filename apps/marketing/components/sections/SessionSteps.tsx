import { ArrowRight } from "lucide-react";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { sessions } from "@/lib/content";

/**
 * How a session works, in four steps. Carries `id="how"` so the old
 * "How it works" links still land on the right section.
 */
export function SessionSteps() {
  return (
    <section id="how" className="scroll-mt-20 border-t border-line py-24">
      <div className="container">
        <SectionHeading kicker={sessions.kicker} title={sessions.title} sub={sessions.sub} />

        <ol className="mx-auto mt-14 grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {sessions.steps.map((step, i) => (
            <Reveal as="li" key={step.title} delay={i * 0.06}>
              <div className="h-full rounded-2xl border border-line bg-white p-5 shadow-soft">
                <p className="font-mono text-xs text-clay-600">0{i + 1}</p>
                <h3 className="mt-2 font-display text-lg font-semibold text-ink">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{step.body}</p>
              </div>
            </Reveal>
          ))}
        </ol>

        <div className="mt-8 text-center">
          <a
            href="/features/sessions"
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-clay-600 hover:text-clay"
          >
            {sessions.link}
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>
    </section>
  );
}
