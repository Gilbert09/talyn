import { Reveal } from "@/components/ui/Reveal";
import { cn } from "@/lib/utils";

export function SectionHeading({
  kicker,
  title,
  sub,
  align = "center",
  className,
}: {
  kicker?: string;
  title: string;
  sub?: string;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <Reveal
      className={cn(
        "max-w-2xl",
        align === "center" ? "mx-auto text-center" : "text-left",
        className
      )}
    >
      {kicker && (
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
          {kicker}
        </p>
      )}
      <h2 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        {title}
      </h2>
      {sub && <p className="mt-4 text-lg text-ink-500">{sub}</p>}
    </Reveal>
  );
}
