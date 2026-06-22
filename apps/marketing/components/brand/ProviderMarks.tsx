import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Simplified provider marks for the "bring your own agent" strip. These are
 * tasteful stand-ins (currentColor) — swap for the official Claude / PostHog
 * brand SVGs before any high-visibility launch.
 */

/** Anthropic / Claude — radial "spark" burst (alternating spoke lengths). */
export function ClaudeMark({ className }: { className?: string }) {
  const spokes = Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    const r = i % 2 === 0 ? 8 : 5.2;
    return {
      x2: +(12 + r * Math.cos(a)).toFixed(2),
      y2: +(12 + r * Math.sin(a)).toFixed(2),
    };
  });
  return (
    <svg viewBox="0 0 24 24" className={cn(className)} aria-hidden>
      <g
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      >
        {spokes.map((s, i) => (
          <line key={i} x1="12" y1="12" x2={s.x2} y2={s.y2} />
        ))}
      </g>
    </svg>
  );
}

/** PostHog — simplified hedgehog silhouette. */
export function PostHogMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn(className)} fill="currentColor" aria-hidden>
      {/* spiky back + rounded body */}
      <path
        d="M3 17.5c0-1 .5-2 1.4-2.6L4 13l1.8.9.2-2.2 1.7 1.3.7-2.3 1.4 1.8 1-2.3 1.2 2 1.3-2 .9 2.2 1.6-1.6.3 2.2 1.9-.9-.2 2.1c.7.6 1.1 1.4 1.1 2.3 0 .3-.25.5-.55.5H3.55C3.25 18 3 17.8 3 17.5Z"
      />
      {/* snout */}
      <path d="M2.4 16.2c-.7-.2-1.4.3-1.4 1 0 .6.5 1 1.1 1l1.9-.1-.2-1.6-1.4-.3Z" />
      {/* eye */}
      <circle cx="5.4" cy="15.4" r="0.8" fill="#fff" />
    </svg>
  );
}

/** Resolve a content `mark` id to a rendered glyph. */
export function ProviderMark({
  mark,
  className,
}: {
  mark: "claude" | "posthog" | "soon";
  className?: string;
}) {
  if (mark === "claude") return <ClaudeMark className={className} />;
  if (mark === "posthog") return <PostHogMark className={className} />;
  return <Sparkles className={className} />;
}
