import { cn } from "@/lib/utils";

/**
 * Owl mark — line-art owl echoing the desktop app icon, with a sharp talon
 * sweep doubling as the brow. `currentColor` driven so it tints anywhere.
 */
export function OwlMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      className={cn(className)}
      stroke="currentColor"
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* head dome */}
      <path d="M18 22 C 21 10 43 10 46 22" />
      {/* wings */}
      <path d="M16 25 C 11 33 11 46 18 53" />
      <path d="M48 25 C 53 33 53 46 46 53" />
      {/* eyes */}
      <circle cx="25.5" cy="30" r="4.4" />
      <circle cx="38.5" cy="30" r="4.4" />
      {/* beak (a talon-like sweep) */}
      <path d="M29 37 L 32 43 L 35 37" />
      {/* belly */}
      <path d="M27 49 Q 32 52 37 49" />
    </svg>
  );
}

/** Wordmark: owl mark + "Talyn" set in the display face. */
export function Logo({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <OwlMark className={cn("h-7 w-7 text-talon-300", markClassName)} />
      <span className="font-display text-xl font-semibold tracking-tight text-white">
        Talyn
      </span>
    </span>
  );
}
