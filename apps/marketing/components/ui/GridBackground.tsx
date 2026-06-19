import { cn } from "@/lib/utils";

/**
 * Soft ambient backdrop for light sections: faint warm dotted grid + a barely
 * there clay glow. Sits behind content, never interactive.
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
      <div className="absolute inset-0 bg-dot-grid [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)]" />
      {halo && (
        <>
          <div className="absolute left-1/2 top-[-12%] h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-clay/[0.07] blur-[120px]" />
          <div className="absolute left-[14%] top-[44%] h-[300px] w-[300px] rounded-full bg-clay-200/20 blur-[110px]" />
        </>
      )}
    </div>
  );
}
