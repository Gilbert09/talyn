import Image from "next/image";
import { Sparkles } from "lucide-react";
import { OwlMark } from "@/components/brand/Logo";
import { cn } from "@/lib/utils";

/**
 * Provider logos pulled from logo.dev (publishable token — safe client-side;
 * override with NEXT_PUBLIC_LOGODEV_TOKEN). The "soon" slot has no real brand,
 * so it falls back to a spark glyph.
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
  // The fleet is ours, so it wears our own mark rather than a fetched logo.
  if (mark === "fleet") return <OwlMark className={cn(className)} />;
  if (mark === "soon") return <Sparkles className={cn(className)} aria-hidden />;
  return (
    <Image
      src={logoSrc(DOMAIN[mark])}
      alt={ALT[mark]}
      width={64}
      height={64}
      className={cn("object-contain", className)}
      unoptimized
    />
  );
}
