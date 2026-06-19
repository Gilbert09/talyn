import { cn } from "@/lib/utils";

/**
 * Layered ambient backdrop: dotted grid + owl-blue radial halo + a faint
 * talon-gold glow. Sits behind the hero / section content, never interactive.
 */
export function GridBackground({
  className,
  halo = true,
}: {
  className?: string;
  halo?: boolean;
}) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <div className="absolute inset-0 bg-dot-grid [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
      {halo && (
        <>
          <div className="absolute left-1/2 top-[-10%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-owl-400/20 blur-[120px]" />
          <div className="absolute left-[12%] top-[40%] h-[320px] w-[320px] rounded-full bg-talon/10 blur-[110px]" />
        </>
      )}
    </div>
  );
}
