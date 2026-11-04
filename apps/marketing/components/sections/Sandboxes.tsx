import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { SleepingBanner } from "@/components/mocks/SessionMocks";
import { sandboxes } from "@/lib/content";

/** Parallel sessions and the facts about their sandboxes. */
export function Sandboxes() {
  return (
    <section id="sandboxes" className="border-t border-line bg-paper-100 py-24">
      <div className="container">
        <SectionHeading kicker={sandboxes.kicker} title={sandboxes.title} sub={sandboxes.sub} />

        <div className="mx-auto mt-14 grid max-w-5xl gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {sandboxes.items.map((item, i) => (
            <Reveal key={item.title} delay={(i % 3) * 0.05}>
              <div className="mb-3 h-1 w-8 rounded-full bg-clay" />
              <h3 className="font-display text-base font-semibold text-ink">{item.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{item.body}</p>
            </Reveal>
          ))}
        </div>

        {/* The app's own "asleep" banner, so the claim above it has a picture. */}
        <Reveal className="mx-auto mt-14 max-w-xl">
          <SleepingBanner />
        </Reveal>
      </div>
    </section>
  );
}
