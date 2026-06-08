/**
 * PostHog analytics for the renderer process.
 *
 * Mirrors the PostHog Code desktop app's Electron setup:
 *  - Imports the `module.full.no-external` bundle plus `posthog-recorder`, so
 *    the SDK *and* the session-replay recorder are fully inlined. Our renderer
 *    runs under a strict CSP (`script-src 'self'`) and is served from
 *    `file://` when packaged, so the normal posthog-js behaviour of lazily
 *    fetching the recorder/extensions from the PostHog CDN would be blocked
 *    and session replay would silently never start.
 *  - A small guarded helper module (rather than the React provider), so calls
 *    are safe no-ops until PostHog is initialised.
 *
 * Analytics is disabled entirely until `FASTOWL_POSTHOG_KEY` is baked in at
 * build time (see the webpack EnvironmentPlugin configs).
 */
import posthog from 'posthog-js/dist/module.full.no-external';
// Inlines the session-replay recorder so it never needs to load from the CDN.
import 'posthog-js/dist/posthog-recorder';

const KEY = process.env.FASTOWL_POSTHOG_KEY || '';
const HOST = process.env.FASTOWL_POSTHOG_HOST || 'https://us.i.posthog.com';
const IS_DEV = process.env.NODE_ENV !== 'production';

let initialized = false;

/** Whether a PostHog project key was baked into this build. */
export function isAnalyticsConfigured(): boolean {
  return Boolean(KEY);
}

/** Initialise PostHog once. No-op without a key. Call once at app startup. */
export function initAnalytics(): void {
  if (initialized || !KEY) return;
  initialized = true;

  posthog.init(KEY, {
    api_host: HOST,
    ui_host: uiHostFor(HOST),
    // A packaged renderer loads from file://, which has no cookies — keep all
    // persistence in localStorage.
    persistence: 'localStorage',
    // Don't materialise person profiles for anonymous usage.
    person_profiles: 'identified_only',
    // A desktop app has no page navigations; panels are tracked as events.
    capture_pageview: false,
    autocapture: true,
    disable_session_recording: false,
    // Exception autocapture is noisy against a dev server; enable it in
    // packaged builds only.
    capture_exceptions: IS_DEV
      ? false
      : {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: true,
        },
    loaded: (ph) => {
      ph.startSessionRecording();
    },
  });

  // Tag every event with the app version (mirrors PostHog Code's super
  // property). Resolved async from the main process.
  window.electron?.app
    ?.getVersion()
    .then((version) => posthog.register({ app_version: version }))
    .catch(() => {});

  trackEvent('app_opened');
}

/** Link subsequent events to a known user. */
export function identifyAnalyticsUser(
  distinctId: string,
  properties?: Record<string, unknown>,
): void {
  if (initialized) posthog.identify(distinctId, properties);
}

/** Clear identity + start a fresh session. Call on logout. */
export function resetAnalyticsUser(): void {
  if (initialized) posthog.reset();
}

/** Capture a custom product-analytics event. */
export function trackEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (initialized) posthog.capture(event, properties);
}

/** Manually capture a caught exception. */
export function captureAnalyticsException(
  error: unknown,
  properties?: Record<string, unknown>,
): void {
  if (initialized) posthog.captureException(error, properties);
}

/** Ingestion host → app host, for "view recording" deep links. */
function uiHostFor(host: string): string {
  return host
    .replace('us.i.posthog.com', 'us.posthog.com')
    .replace('eu.i.posthog.com', 'eu.posthog.com');
}
