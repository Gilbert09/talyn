import { ArrowRight } from "lucide-react";
import { GlowCard } from "@/components/ui/GlowCard";
import { cn } from "@/lib/utils";

/**
 * A card that links somewhere.
 *
 * Used by the homepage grid, the /features hub and the related-pages block at
 * the foot of every sub-page. The whole card is the anchor rather than the
 * arrow: a 300-pixel-wide target beats a 16-pixel one, and it means the hover
 * state and the link are the same thing.
 */
export function FeatureCard({
  eyebrow,
  title,
  body,
  href,
  cta = "Read more",
  id,
  className,
}: {
  eyebrow?: string;
  title: string;
  body: string;
  href: string;
  cta?: string;
  /**
   * Anchor id. The homepage grid keeps the per-feature ids the old full-width
   * blocks carried (`#workflows`, `#loops`), so an inbound link written before
   * these pages existed still lands on something about the right feature.
   */
  id?: string;
  className?: string;
}) {
  return (
    <a
      id={id}
      href={href}
      className={cn("group block h-full scroll-mt-24", className)}
    >
      <GlowCard className="flex h-full flex-col" tone="clay">
        {eyebrow && (
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-clay-600">
            {eyebrow}
          </p>
        )}
        <h3 className="font-display text-lg font-semibold tracking-tight text-ink">
          {title}
        </h3>
        <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-500">{body}</p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-clay-600">
          {cta}
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </GlowCard>
    </a>
  );
}
