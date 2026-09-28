import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { site } from "@/lib/content";

/**
 * The end-of-page conversion band.
 *
 * Lifted out of `app/[slug]/page.tsx`, where it was written inline, because
 * every feature and comparison page wants the same thing: one CTA, at the
 * bottom, after the page has been useful. A reader who bounced at the top was
 * never going to download anything.
 *
 * `placement` is required rather than defaulted. It is the only thing that
 * makes `download_click` answer "which page converts", and a default would
 * quietly lump a new page in with whatever the default was.
 */
export function PageCta({
  title = "Talyn does this for you.",
  body = "Mission control for your GitHub pull requests, running on the Claude or ChatGPT subscription you already pay for. Free for three tasks at a time.",
  placement,
  className = "mt-14",
}: {
  title?: string;
  body?: string;
  placement: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-line bg-paper-100 p-6 ${className}`}
    >
      <p className="font-display text-lg font-semibold text-ink">{title}</p>
      <p className="mt-1.5 text-[15px] leading-relaxed text-ink-500">{body}</p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <DownloadButton size="md" placement={placement} />
        <a href={site.appUrl}>
          <Button variant="secondary" size="md">
            Open in browser
          </Button>
        </a>
      </div>
    </div>
  );
}
