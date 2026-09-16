import posthog from "posthog-js";

/**
 * Publishable (write-only) project key, safe to ship in client code.
 * NEXT_PUBLIC_POSTHOG_KEY overrides it at build time (e.g. to point a
 * preview deploy elsewhere, or set it empty to disable capture).
 */
const POSTHOG_KEY =
  process.env.NEXT_PUBLIC_POSTHOG_KEY ??
  "phc_n7cmPaZ8BZkgnBV9seBGqaJTtcjd9NYbKTUhcLXTohwX";
const POSTHOG_HOST =
  process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

let started = false;

export function initPostHog(): void {
  if (started || !POSTHOG_KEY || typeof window === "undefined") return;
  // Persistence is left at the default on purpose. posthog-js writes its
  // cookie on the registrable domain (`.talyn.dev`) unless the host is one of
  // herokuapp.com / vercel.app / netlify.app, so the anonymous distinct id
  // minted here is the SAME one app.talyn.dev reads — which is what lets a
  // visitor and the account they later create merge into one person, carrying
  // the referrer and utm_* that brought them.
  //
  // Do NOT call posthog.identify() here — not on the waitlist form, not
  // anywhere. Identifying by email would mint a second *identified* person,
  // and PostHog will not merge one identified person into another, so the
  // app's identify(supabaseUserId) could no longer claim this visit. The
  // anonymous id is the link; leaving it alone is the feature.
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
