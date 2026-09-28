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
  // Do NOT call posthog.identify() here — not from any future email capture,
  // not anywhere. Identifying by email would mint a second *identified* person,
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

/**
 * Send an event and WAIT for PostHog to acknowledge it.
 *
 * Every other event on this site is fire-and-forget, which is right: nobody is
 * harmed by a lost `download_click`. The teams enquiry is different, because
 * PostHog is the only place it goes — so a silent failure means somebody
 * typed their email, read a thank-you, and was never heard from. That is the
 * precise failure the waitlist form was deleted for (see FinalCta.tsx: it
 * "lied").
 *
 * This posts to the capture endpoint directly rather than calling
 * `posthog.capture()`, and the reason is worth writing down because the
 * obvious approach does not work. `posthog-js` is an npm dependency here, not
 * a CDN script, so an ad blocker does not stop the library loading — it stops
 * the REQUEST. `posthog.capture()` therefore succeeds, `posthog.__loaded` is
 * true, and the event dies in a queue that never drains. A first attempt at
 * this guard checked exactly that and reported success on a blocked browser;
 * the Playwright run that simulated an ad blocker is what caught it.
 *
 * `distinct_id` is read off the live library so the enquiry still attaches to
 * the same anonymous person as their pageviews — that is what makes the
 * dashboard able to say which page they came from.
 */
export async function captureWithDelivery(
  event: string,
  props?: Record<string, unknown>
): Promise<boolean> {
  if (!isAnalyticsEnabled()) return false;
  try {
    const distinctId =
      (typeof posthog.get_distinct_id === "function"
        ? posthog.get_distinct_id()
        : null) ?? `anon-${Date.now()}`;

    const res = await fetch(`${POSTHOG_HOST}/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: distinctId,
        properties: {
          ...props,
          $current_url: window.location.href,
          // Sent explicitly: this request does not go through the library, so
          // none of its automatic context comes along for the ride.
          $host: window.location.host,
          $pathname: window.location.pathname,
        },
        timestamp: new Date().toISOString(),
      }),
    });
    return res.ok;
  } catch {
    // Blocked, offline, or the host is unreachable. All of them mean the
    // enquiry did not arrive, and the caller has to say so.
    return false;
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

