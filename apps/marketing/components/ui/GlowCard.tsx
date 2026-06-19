"use client";

import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Card with a cursor-following radial highlight (Aceternity-style spotlight),
 * themed to owl-blue. Pure CSS var update on mousemove — cheap, no re-render.
 */
export function GlowCard({
  children,
  className,
  tone = "blue",
}: {
  children: ReactNode;
  className?: string;
  tone?: "blue" | "talon";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const glow =
    tone === "talon" ? "rgba(245,185,77,0.16)" : "rgba(125,162,232,0.18)";

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
        "group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors hover:border-white/20",
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
