import { ArrowRight } from "lucide-react";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { automation } from "@/lib/content";

/** Loops, workflows, Slack, MCP servers, skills and the public API. */
export function Automation() {
  return (
    <section id="automation" className="scroll-mt-20 border-t border-line bg-paper-100 py-24">
      <div className="container">
        <SectionHeading kicker={automation.kicker} title={automation.title} sub={automation.sub} />

        <div className="mx-auto mt-14 grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {automation.items.map((item, i) => {
            const external = item.href?.startsWith("http");
            const body = (
              <>
                <h3 className="font-display text-base font-semibold text-ink">{item.title}</h3>
                <p className="mt-1.5 flex-1 text-sm leading-relaxed text-ink-500">{item.body}</p>
                {item.href && (
                  <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-clay-600">
                    {external ? "Read the docs" : "Read more"}
                    <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                  </span>
                )}
              </>
            );
            const card =
              "group flex h-full flex-col rounded-2xl border border-line bg-white p-5 shadow-soft transition-colors";
            return (
              <Reveal key={item.title} delay={(i % 3) * 0.05}>
                {item.href ? (
                  <a
                    href={item.href}
                    {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                    className={`${card} hover:border-line-strong`}
                  >
                    {body}
                  </a>
                ) : (
                  <div className={card}>{body}</div>
                )}
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
