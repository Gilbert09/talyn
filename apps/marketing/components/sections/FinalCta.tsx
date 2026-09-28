import { Reveal } from "@/components/ui/Reveal";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { OwlMark } from "@/components/brand/Logo";
import { site, finalCta } from "@/lib/content";

/**
 * The closing conversion section. Carries id="download" (footer links to it).
 *
 * The "want release notes?" email row is gone, and not because nobody used it —
 * though nobody did: `waitlist_signup` never fired once in the project's
 * history, and no click ever landed on the field or the button. It is gone
 * because it lied. Submitting it answered "You're on the list" while the
 * address went into a PostHog event property and no list at all, and the
 * privacy policy promised we kept it.
 *
 * Bring it back when there is something to send — the changelog is the obvious
 * trigger — wired to a real provider, and somewhere it can be seen. Below the
 * FAQ on a page where the median visitor is active for about twenty seconds is
 * not that place.
 */
export function FinalCta() {
  return (
    <section id="download" className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[360px] w-[680px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-clay/[0.07] blur-[140px]"
      />
      <div className="container relative text-center">
        <Reveal>
          <OwlMark className="mx-auto h-12 w-12 animate-blink text-clay" />
          <h2 className="mx-auto mt-6 max-w-2xl font-display text-4xl font-semibold leading-tight tracking-tight text-ink sm:text-5xl">
            {finalCta.titleLead}
            <br />
            <span className="text-clay">{finalCta.titleAccent}</span>
          </h2>
          <p className="mx-auto mt-5 max-w-md text-ink-500">{finalCta.sub}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <DownloadButton size="lg" placement="final-cta">{finalCta.cta}</DownloadButton>
            <a href={site.appUrl}>
              <Button variant="secondary" size="lg">
                Open in browser
              </Button>
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
