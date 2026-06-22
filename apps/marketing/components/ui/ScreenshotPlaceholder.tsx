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
      <AppFrame title={title ?? "Talyn"} glow={glow}>
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
    </div>
  );
}
