"use client";

import { useState } from "react";
import Image from "next/image";
import { Sparkles } from "lucide-react";
import { OwlMark } from "@/components/brand/Logo";
import { cn } from "@/lib/utils";

/**
 * Provider logos pulled from logo.dev (publishable token — safe client-side;
 * override with NEXT_PUBLIC_LOGODEV_TOKEN). The "soon" slot has no real brand,
 * so it falls back to a spark glyph.
 *
 * These three marks ARE the site's only logo wall, and they were a single
 * third-party outage away from rendering as three broken images in the one
 * section whose entire job is to look credible. An ad blocker, a corporate
 * egress rule or a bad day at logo.dev all produce the same picture.
 *
 * So there is a fallback, and it is not self-hosting: these are other
 * companies' trademarks and keeping copies of them in our repo is a different
 * problem from the one being solved. On error the mark degrades to the
 * provider's initial in our own type — plain, obviously deliberate, and
 * indistinguishable from a design choice rather than a failure.
 */
const TOKEN =
  process.env.NEXT_PUBLIC_LOGODEV_TOKEN || "pk_dPyp6cM4QayP8Jqj4nW9HA";

const DOMAIN: Record<"claude" | "codex" | "posthog", string> = {
  claude: "claude.ai",
  // Codex is OpenAI's, so it wears OpenAI's mark — there is no separate Codex
  // brand to fetch. Matches `CODEX_LOGO` in the apps, which is the same fetch.
  codex: "openai.com",
  posthog: "posthog.com",
};

const ALT: Record<"claude" | "codex" | "posthog", string> = {
  claude: "Claude",
  codex: "Codex",
  posthog: "PostHog",
};

function logoSrc(domain: string): string {
  return `https://img.logo.dev/${domain}?token=${TOKEN}&size=128&format=png`;
}

export type ProviderMarkName = "claude" | "codex" | "posthog" | "soon" | "fleet";

export function ProviderMark({
  mark,
  className,
}: {
  mark: ProviderMarkName;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  // The fleet is ours, so it wears our own mark rather than a fetched logo.
  if (mark === "fleet") return <OwlMark className={cn(className)} />;
  if (mark === "soon") return <Sparkles className={cn(className)} aria-hidden />;

  if (failed) {
    return (
      <span
        aria-label={ALT[mark]}
        role="img"
        className={cn(
          "inline-flex items-center justify-center font-display font-semibold text-clay-600",
          className
        )}
      >
        {ALT[mark].charAt(0)}
      </span>
    );
  }

  return (
    <Image
      src={logoSrc(DOMAIN[mark])}
      alt={ALT[mark]}
      width={64}
      height={64}
      className={cn("object-contain", className)}
      onError={() => setFailed(true)}
      unoptimized
    />
  );
}
