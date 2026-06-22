import posthog from "posthog-js";

/** PostHog is opt-in: inert unless NEXT_PUBLIC_POSTHOG_KEY is set at build. */
const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST =
  process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

let started = false;

export function initPostHog(): void {
  if (started || !POSTHOG_KEY || typeof window === "undefined") return;
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    // We capture pageviews manually on route change (App Router).
    capture_pageview: false,
    capture_pageleave: true,
  });
  started = true;
}

export function isAnalyticsEnabled(): boolean {
  return !!POSTHOG_KEY && typeof window !== "undefined";
}

/** Fire-and-forget event capture; a no-op when analytics is disabled. */
export function capture(event: string, props?: Record<string, unknown>): void {
  try {
    if (isAnalyticsEnabled()) posthog.capture(event, props);
  } catch {
    // Analytics must never break the page.
  }
}

export function capturePageview(): void {
  try {
    if (isAnalyticsEnabled())
      posthog.capture("$pageview", { $current_url: window.location.href });
  } catch {
    /* noop */
  }
}

export function captureSignup(email: string): void {
  capture("waitlist_signup", { email });
}
