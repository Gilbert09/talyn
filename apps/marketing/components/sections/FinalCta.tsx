import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/ui/Reveal";
import { OwlMark } from "@/components/brand/Logo";
import { site } from "@/lib/content";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[400px] w-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-talon/10 blur-[140px]"
      />
      <div className="container relative text-center">
        <Reveal>
          <OwlMark className="mx-auto h-12 w-12 animate-blink text-talon-300" />
          <h2 className="mx-auto mt-6 max-w-2xl font-display text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
            Stop babysitting CI.
            <br />
            <span className="text-gradient-talon">Let the talons out.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-md text-owl-50/60">
            Free while in beta. Bring your own agent. Clear your PR backlog tonight.
          </p>
          <div className="mt-8 flex justify-center">
            <a href={site.downloadUrl}>
              <Button size="lg">
                <Download className="h-5 w-5" />
                Download for Mac
              </Button>
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
