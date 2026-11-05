"use client";

import { useEffect } from "react";

/**
 * Wires up the "Copy" buttons that `lib/docs.ts` renders into every code
 * block. One delegated listener for the page rather than a React component
 * per block, because the blocks arrive as rendered markdown HTML.
 */
export function CopyCode() {
  useEffect(() => {
    const onClick = async (e: MouseEvent) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
      if (!button) return;
      const code = button.parentElement?.querySelector("pre code");
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      }
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1600);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return null;
}
