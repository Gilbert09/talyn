"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { initPostHog, capturePageview } from "@/lib/analytics";

/**
 * Boots PostHog (inert without NEXT_PUBLIC_POSTHOG_KEY) and emits a manual
 * $pageview on every App Router navigation. Renders nothing.
 */
export function Analytics() {
  const pathname = usePathname();

  useEffect(() => {
    initPostHog();
  }, []);

  useEffect(() => {
    if (!pathname) return;
    capturePageview();
  }, [pathname]);

  return null;
}
