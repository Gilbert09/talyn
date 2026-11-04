import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { FeatureCard } from "@/components/ui/FeatureCard";
import { ScreenshotPlaceholder } from "@/components/ui/ScreenshotPlaceholder";
import { pullRequests } from "@/lib/content";

/** The PR side of the product: the GitHub panel, fixes, the queue, review. */
export function PullRequests() {
  return (
    <section id="pull-requests" className="scroll-mt-20 border-t border-line bg-paper-100 py-24">
      <div className="container">
        <SectionHeading
          kicker={pullRequests.kicker}
          title={pullRequests.title}
          sub={pullRequests.sub}
        />

        <Reveal className="mx-auto mt-14 max-w-4xl">
          <ScreenshotPlaceholder shot="dashboard" title="Talyn · Pull requests" glow={false} />
        </Reveal>

        <div className="mx-auto mt-10 grid max-w-5xl gap-4 md:grid-cols-3">
          {pullRequests.items.map((item, i) => (
            <Reveal key={item.title} delay={i * 0.06}>
              <FeatureCard title={item.title} body={item.body} href={item.href} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
