"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { DownloadButton, isMobileDevice } from "@/components/ui/DownloadButton";
import { WebAppButton } from "@/components/ui/WebAppButton";
import { PlatformNote } from "@/components/ui/PlatformNote";
import { Badge } from "@/components/ui/badge";
import { GridBackground } from "@/components/ui/GridBackground";
import { AppFrame } from "@/components/ui/AppFrame";
import { SessionDemo } from "@/components/mocks/SessionDemo";
import { TypedRotator } from "@/components/ui/TypedRotator";
import { hero } from "@/lib/content";
import { cn } from "@/lib/utils";

export function Hero() {
  // Resolved after mount, like the download button's own label: the server has
  // no navigator, so deciding this during render would hydrate-mismatch.
  // Defaults to false, so the desktop order is what gets server-rendered.
  const [mobile, setMobile] = useState(false);
  useEffect(() => setMobile(isMobileDevice()), []);

  return (
    <section id="top" className="relative overflow-hidden pt-28 pb-16 sm:pt-32">
      <GridBackground />
      {/* scan-bar glow echoing the app boot screen */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-24 h-px w-[60%] -translate-x-1/2 animate-scan bg-gradient-to-r from-transparent via-clay/40 to-transparent"
      />

      <div className="container relative">
        <motion.div
          // Visible from the first paint: the headline is the page's largest
          // text, so hiding it until the script loads delayed LCP. It still
          // settles up into place.
          initial={{ y: 12 }}
          animate={{ y: 0 }}
          transition={{ duration: 0.7, ease: [0.21, 0.47, 0.32, 0.98] }}
          className="mx-auto max-w-5xl text-center"
        >
          <div className="mb-6 flex justify-center">
            {hero.announcement ? (
              <a
                href={hero.announcement.href}
                className="transition-opacity hover:opacity-80"
              >
                <Badge dot>
                  {hero.announcement.label}
                  <ArrowRight className="h-3 w-3" />
                </Badge>
              </a>
            ) : (
              <Badge dot>{hero.badge}</Badge>
            )}
          </div>

          {/* Each part on its own line so a free-flowing wrap cannot break
              the phrase in an odd place at laptop widths. */}
          <h1 className="font-display text-4xl font-semibold leading-[1.06] tracking-tight text-ink [text-wrap:balance] sm:text-5xl lg:text-6xl">
            <span className="block">{hero.titleLead}</span>{" "}
            <TypedRotator phrases={hero.titleAccents} className="text-clay" />
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-ink-500 [text-wrap:pretty]">
            {hero.sub}
          </p>

          {/* The browser app is a peer of the download, not a footnote: it is
              the whole product with nothing to install, and the only option
              for anyone who can't or won't install one. On a phone it is the
              ONLY option, so the order flips — 21% of visitors are on iOS or
              Android and were being offered a desktop binary. */}
          <div
            className={cn(
              "mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row",
              mobile && "sm:flex-row-reverse"
            )}
          >
            <DownloadButton
              size="lg"
              placement="hero"
              variant={mobile ? "secondary" : "primary"}
            >
              {hero.primaryCta}
            </DownloadButton>
            <WebAppButton
              size="lg"
              placement="hero"
              variant={mobile ? "primary" : "secondary"}
            >
              {hero.webCta}
            </WebAppButton>
          </div>

          {/* ONE line under the buttons, not four.
              It was the microtrust line, then PlatformNote, then a "See how it
              works" link — three stacked greys competing with the thing they
              sit under, plus the badge above the headline. The comparison that
              made it obvious: t3.codes puts a single line here.

              PlatformNote survives because it is the one that changes by
              platform and carries real consequence (the SmartScreen warning on
              Windows, the Intel Mac build). It renders nothing until the sniff
              resolves, so the fold is quieter still on first paint. The "see
              how it works" link goes: the section is two screens down and the
              page scrolls. */}
          <p className="mt-3 font-mono text-xs text-ink-400">{hero.microtrust}</p>
          <PlatformNote className="mx-auto mt-1.5 max-w-md" />
        </motion.div>

        {/* mt-10: keep the top of the session mock above the fold on a
            laptop viewport. */}
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.15, ease: [0.21, 0.47, 0.32, 0.98] }}
          className="relative mx-auto mt-10 max-w-6xl"
        >
          {/* Plays a session from prompt to merged pull request. */}
          <AppFrame title="Talyn · Add CSV export">
            <SessionDemo />
          </AppFrame>
          {/* Ties the film to the headline's promise at the point where half
              of visitors decide to leave. */}
          <p className="mt-3 text-center text-xs text-ink-400">
            Sped up. Close the app at any step and the sandbox keeps working.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
