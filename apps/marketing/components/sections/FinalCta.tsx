import { Reveal } from "@/components/ui/Reveal";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { OwlMark } from "@/components/brand/Logo";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[360px] w-[680px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-clay/[0.07] blur-[140px]"
      />
      <div className="container relative text-center">
        <Reveal>
          <OwlMark className="mx-auto h-12 w-12 animate-blink text-clay" />
          <h2 className="mx-auto mt-6 max-w-2xl font-display text-4xl font-semibold leading-tight tracking-tight text-ink sm:text-5xl">
            Stop babysitting CI.
            <br />
            <span className="text-clay">Let the talons out.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-md text-ink-500">
            In public beta. Bring your own agent. Clear your PR backlog tonight.
          </p>
          <div className="mt-8 flex justify-center">
            <DownloadButton size="lg">Download for Mac</DownloadButton>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
