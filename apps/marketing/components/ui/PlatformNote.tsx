"use client";

import { useEffect, useState } from "react";
import { detectPlatform, isMobileDevice } from "@/components/ui/DownloadButton";
import { site } from "@/lib/content";
import { cn } from "@/lib/utils";

const RELEASES_URL = `${site.githubUrl}/releases`;

/**
 * The line under a download CTA that says what actually happens next.
 *
 * Three facts the site knew and never told anyone at the point it mattered.
 *
 * **Windows.** 42% of visitors and 90% of real download clicks — 27 distinct
 * people last month, one click each. The installer is not yet code-signed, so
 * every one of them met a SmartScreen warning with no warning. That caveat
 * existed in exactly one place: body prose most of the way down
 * /features/pr-dashboard. A warning you were told to expect is a step; the
 * same warning met cold is a reason to close the tab.
 *
 * **Intel Macs.** The button tries the arm64 .dmg first and there is no way
 * to ask the browser which CPU it is on, so an Intel user downloads a file
 * that will not open. The releases page carries both builds — link it.
 *
 * **Phones.** 21% of visitors are on iOS or Android and cannot install any of
 * this. Rather than offering them a binary, say so and point at the browser.
 *
 * Resolved after mount like the button's own label, so the server renders
 * nothing and there is no hydration mismatch.
 */
export function PlatformNote({ className }: { className?: string }) {
  const [note, setNote] = useState<React.ReactNode>(null);

  useEffect(() => {
    if (isMobileDevice()) {
      setNote(<>Talyn is a desktop and browser app — open it in your browser here.</>);
      return;
    }
    const platform = detectPlatform();
    if (platform.key === "windows") {
      setNote(
        <>
          Windows will show a SmartScreen warning on first install — choose{" "}
          <strong className="font-medium text-ink-500">More info</strong> then{" "}
          <strong className="font-medium text-ink-500">Run anyway</strong>. We
          have not bought a signing certificate yet.
        </>
      );
      return;
    }
    if (platform.key === "mac") {
      setNote(
        <>
          Apple silicon build. On an Intel Mac, take the x64 one from the{" "}
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-clay-600"
          >
            releases page
          </a>
          .
        </>
      );
      return;
    }
    setNote(
      <>
        AppImage — <code className="font-mono">chmod +x</code> it and run. Other
        builds are on the{" "}
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-clay-600"
        >
          releases page
        </a>
        .
      </>
    );
  }, []);

  if (!note) return null;
  return (
    <p className={cn("text-xs leading-relaxed text-ink-400", className)}>{note}</p>
  );
}
