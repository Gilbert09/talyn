import Image from "next/image";
import { AppFrame } from "@/components/ui/AppFrame";
import { MOCKS, type MockId } from "@/components/mocks/AppMocks";
import { cn } from "@/lib/utils";

/**
 * Renders a framed product visual. By default it renders the in-browser HTML
 * mock for `shot`. To use a real capture instead, drop a PNG at
 * /public/screenshots/<shot>.png and pass `src` — the mock is the fallback.
 */
export function ScreenshotPlaceholder({
  shot,
  src,
  title,
  className,
  glow = true,
}: {
  shot: MockId;
  src?: string;
  title?: string;
  className?: string;
  glow?: boolean;
}) {
  const Mock = MOCKS[shot];
  return (
    <div className={cn("relative", className)}>
      <AppFrame title={title ?? `Talyn — ${shot}`} glow={glow}>
        {src ? (
          <Image
            src={src}
            alt={title ?? shot}
            width={1280}
            height={760}
            className="w-full"
          />
        ) : (
          <Mock />
        )}
      </AppFrame>
      {!src && (
        <span className="absolute right-3 top-3 rounded-md border border-line bg-white/80 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-ink-400 backdrop-blur">
          preview
        </span>
      )}
    </div>
  );
}
