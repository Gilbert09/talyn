import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** macOS-style window chrome used to frame product mockups / screenshots. */
export function AppFrame({
  children,
  title = "Talyn",
  className,
  glow = true,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
  glow?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative rounded-2xl border border-white/10 bg-ink-800/80 shadow-frame backdrop-blur",
        glow && "shadow-glow",
        className
      )}
    >
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 font-mono text-xs text-owl-50/40">{title}</span>
      </div>
      <div className="overflow-hidden rounded-b-2xl">{children}</div>
    </div>
  );
}
