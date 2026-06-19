import { RefreshCw, Bug, GitBranch, Eye } from "lucide-react";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { problem } from "@/lib/content";

const icons = [RefreshCw, Bug, GitBranch, Eye];

export function Problem() {
  return (
    <section className="relative py-24">
      <div className="container">
        <SectionHeading kicker={problem.kicker} title={problem.title} />
        <Reveal className="mx-auto mt-4 max-w-2xl text-center text-lg text-ink-500">
          {problem.body}
        </Reveal>

        <div className="mx-auto mt-14 grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {problem.pains.map((p, i) => {
            const Icon = icons[i];
            return (
              <Reveal
                key={p.title}
                delay={i * 0.06}
                className="rounded-2xl border border-line bg-white p-5 shadow-soft"
              >
                <div className="mb-3 inline-flex rounded-xl border border-status-red/20 bg-status-red/10 p-2.5">
                  <Icon className="h-5 w-5 text-status-red" />
                </div>
                <h3 className="text-sm font-semibold text-ink">{p.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-500">
                  {p.body}
                </p>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
