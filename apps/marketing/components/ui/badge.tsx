import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  children,
  dot,
}: {
  className?: string;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-line-strong bg-white/70 px-3 py-1 text-xs font-medium text-ink-600 shadow-soft backdrop-blur",
        className
      )}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-clay" />
          <span className="relative inline-flex h-1.5 w-1.5 animate-dot-pulse rounded-full bg-clay" />
        </span>
      )}
      {children}
    </span>
  );
}
