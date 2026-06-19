"use client";

import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Card with a cursor-following warm highlight. Pure CSS-var update on
 * mousemove — cheap, no re-render. Reads as a soft clay wash on light paper.
 */
export function GlowCard({
  children,
  className,
  tone = "plain",
}: {
  children: ReactNode;
  className?: string;
  tone?: "plain" | "clay";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const glow =
    tone === "clay" ? "rgba(194,94,58,0.12)" : "rgba(35,32,27,0.05)";

  return (
    <div
      ref={ref}
      onMouseMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - rect.left}px`);
        el.style.setProperty("--my", `${e.clientY - rect.top}px`);
      }}
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-line bg-white p-6 shadow-soft transition-colors hover:border-line-strong",
        className
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(340px circle at var(--mx,50%) var(--my,0%), ${glow}, transparent 65%)`,
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
