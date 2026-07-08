import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { Reveal } from "@/components/ui/Reveal";
import { midCta } from "@/lib/content";

/** Compact conversion band between the feature walk-through and the rest of
 *  the page, so the mid-page stretch isn't CTA-free. */
export function MidCta() {
  return (
    <section className="border-t border-line bg-paper-100 py-16">
      <div className="container flex flex-col items-center justify-between gap-6 text-center sm:flex-row sm:text-left">
        <Reveal>
          <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
            {midCta.title}
          </h2>
          <p className="mt-1 text-ink-500">{midCta.sub}</p>
        </Reveal>
        <Reveal delay={0.05}>
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <DownloadButton>{midCta.cta}</DownloadButton>
            <a href="#pricing">
              <Button variant="secondary">
                {midCta.secondary}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
