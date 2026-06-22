import Image from "next/image";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Provider logos pulled from logo.dev (publishable token — safe client-side;
 * override with NEXT_PUBLIC_LOGODEV_TOKEN). The "soon" slot has no real brand,
 * so it falls back to a spark glyph.
 */
const TOKEN =
  process.env.NEXT_PUBLIC_LOGODEV_TOKEN || "pk_dPyp6cM4QayP8Jqj4nW9HA";

const DOMAIN: Record<"claude" | "posthog", string> = {
  claude: "claude.ai",
  posthog: "posthog.com",
};

function logoSrc(domain: string): string {
  return `https://img.logo.dev/${domain}?token=${TOKEN}&size=128&format=png`;
}

export function ProviderMark({
  mark,
  className,
}: {
  mark: "claude" | "posthog" | "soon";
  className?: string;
}) {
  if (mark === "soon") return <Sparkles className={cn(className)} aria-hidden />;
  return (
    <Image
      src={logoSrc(DOMAIN[mark])}
      alt={mark === "claude" ? "Claude" : "PostHog"}
      width={64}
      height={64}
      className={cn("object-contain", className)}
      unoptimized
    />
  );
}
