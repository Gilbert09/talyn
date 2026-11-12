import { ArrowRight, Clock, Github, Slack } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { AppFrame } from "@/components/ui/AppFrame";
import { MockThread } from "@/components/mocks/SessionMocks";
import { MockPrDetail } from "@/components/mocks/AppMocks";
import { showcase } from "@/lib/content";
import { cn } from "@/lib/utils";

/**
 * The home page body: one promise per row, one sentence, one picture.
 *
 * Modelled on conductor.build. Reading only the headings tells the story, and
 * every detail lives on a feature page or in the docs behind the row's link.
 */
export function Showcase() {
  return (
    <>
      {showcase.map((row, i) => (
        <section
          key={row.id}
          id={row.id}
          className={cn("scroll-mt-20 border-t border-line py-20", i % 2 === 0 && "bg-paper-100")}
        >
          <div className="container grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
            <Reveal className={cn(i % 2 === 1 && "lg:order-2")}>
              <h2 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
                {row.title}
              </h2>
              <p className="mt-4 max-w-lg text-lg leading-relaxed text-ink-500 [text-wrap:pretty]">
                {row.body}
              </p>
              <a
                href={row.href}
                className="group mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-clay-600 hover:text-clay"
              >
                {row.link}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </a>
            </Reveal>
            <Reveal delay={0.08} className="min-w-0">
              <Visual id={row.id} />
            </Reveal>
          </div>
        </section>
      ))}
    </>
  );
}

function Visual({ id }: { id: (typeof showcase)[number]["id"] }) {
  if (id === "parallel")
    return (
      <AppFrame title="Talyn · Thread" glow={false}>
        <MockThread filters={false} />
      </AppFrame>
    );
  if (id === "pull-requests")
    return (
      <AppFrame title="Talyn · Pull request" glow={false}>
        <MockPrDetail />
      </AppFrame>
    );
  return <Automations />;
}

const AUTOMATIONS = [
  { icon: Github, source: "GitHub", when: "Checks fail on a dependency bump", then: "Send an agent to fix it" },
  { icon: Slack, source: "Slack", when: "Someone mentions @Talyn in #bugs", then: "Start a session on the report" },
  { icon: Clock, source: "Schedule", when: "Weekdays at 09:00", then: "Triage last night's CI failures" },
];

/** Three automations as the Integrations page lists them: a trigger and an action. */
function Automations() {
  return (
    <div className="rounded-2xl border border-line bg-paper-50 p-3 shadow-soft">
      <p className="px-2 pb-2 pt-1 font-mono text-[11px] uppercase tracking-wide text-ink-400">
        Automations
      </p>
      <ul className="space-y-2">
        {AUTOMATIONS.map((a) => (
          <li key={a.source} className="flex items-start gap-3 rounded-xl border border-line bg-white p-3">
            <span className="inline-flex shrink-0 rounded-lg border border-line bg-paper-100 p-1.5">
              <a.icon className="h-4 w-4 text-ink-600" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-medium text-ink">{a.when}</p>
              <p className="mt-0.5 text-ink-500">
                <span className="text-clay-600">→</span> {a.then}
              </p>
            </div>
            <span className="ml-auto shrink-0 rounded-md bg-ink/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-ink-500">
              {a.source}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
