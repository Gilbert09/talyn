import { cn } from "@/lib/utils";

/** ASCII owl motif, ported from the desktop boot screen. Blinks on a timer. */
export function AsciiOwl({ className }: { className?: string }) {
  return (
    <pre
      aria-hidden
      className={cn(
        "select-none font-mono text-[10px] leading-[1.15] text-owl-400/70",
        className
      )}
    >
      {`   ,___,
   (O,O)   talons out.
   /)_)
  --"-"--`}
    </pre>
  );
}
