/**
 * PostHog analytics, session replay and error tracking for the mobile app.
 *
 * A port of apps/web/src/lib/analytics.ts: guarded helpers that are safe
 * no-ops until PostHog is initialised, and that stay no-ops in a build with
 * no `EXPO_PUBLIC_TALYN_POSTHOG_KEY`. Analytics was out of the mobile MVP; Tom
 * reversed that on 2026-11-10 (product analytics, masked replay and error
 * tracking, with an opt-out in Settings).
 */
import { exceptionDropReason, isConnectivityMessage } from '@talyn/shared';
import Constants from 'expo-constants';
import PostHog, { type PostHogOptions } from 'posthog-react-native';
import { Platform } from 'react-native';

import type { AnalyticsConfig, AppEnvironment } from '../config';
import { appInfo } from '../features/settings/about';

/** Device-wide, like web: the choice is about this device, not one account. */
export const OPT_OUT_KEY = 'talyn.analytics.opt-out';

type CaptureEvent = Parameters<Extract<NonNullable<PostHogOptions['before_send']>, (...args: never[]) => unknown>>[0];
type Reachability = 'online' | 'offline' | 'unknown';
/** Event properties as the SDK types them: JSON values only. */
export type AnalyticsProperties = NonNullable<Parameters<PostHog['capture']>[1]>;

let client: PostHog | null = null;
let initPromise: Promise<PostHog | null> | null = null;
let optedOut = false;
let reachability: Reachability = 'unknown';
let buildProperties: AnalyticsProperties = {};

/** The PostHog key and host from the app config's `extra`, or null when analytics is off. */
export function analyticsConfigOf(extra: unknown): AnalyticsConfig | null {
  const value = extra && typeof extra === 'object' ? (extra as { analytics?: unknown }).analytics : undefined;
  if (!value || typeof value !== 'object') return null;
  const { key, host } = value as Partial<AnalyticsConfig>;
  return typeof key === 'string' && key && typeof host === 'string' && host ? { key, host } : null;
}

function appEnvironmentOf(extra: unknown): AppEnvironment {
  const value = extra && typeof extra === 'object' ? (extra as { appEnvironment?: unknown }).appEnvironment : undefined;
  return value === 'preview' || value === 'production' ? value : 'development';
}

function configExtra(): unknown {
  return Constants.expoConfig?.extra;
}

/** Whether a PostHog project key was built into this app. */
export function isAnalyticsConfigured(): boolean {
  return analyticsConfigOf(configExtra()) !== null;
}

/**
 * Super properties that describe the BUILD rather than the user, so they are
 * registered again after every reset. `client` separates mobile from web and
 * desktop in the same project, as on web.
 */
export function buildSuperProperties(environment: AppEnvironment): AnalyticsProperties {
  const info = appInfo();
  return {
    client: 'mobile',
    platform: Platform.OS,
    app_version: info.version,
    ...(info.build ? { app_build: info.build } : {}),
    // The OTA update the app runs. Null means the update built into the binary.
    update_id: info.update,
    ...(info.channel ? { update_channel: info.channel } : {}),
    environment,
  };
}

/**
 * Drop or tag a captured exception, exactly like web `before_send`. Events
 * that can never be acted on in code are dropped; the rest carry `online`
 * and `connectivity_error` so a backend outage reads apart from a bug.
 */
export function beforeSend(event: CaptureEvent | null): CaptureEvent | null {
  if (!event || event.event !== '$exception') return event;
  const list = event.properties?.$exception_list as Array<{
    value?: string;
    stacktrace?: { frames?: Array<{ source?: string; filename?: string; abs_path?: string }> };
  }> | undefined;
  const message = list?.map((entry) => entry?.value ?? '').join(' ') ?? '';
  const sources = list?.flatMap((entry) => entry?.stacktrace?.frames
    ?.map((frame) => frame?.source ?? frame?.filename ?? frame?.abs_path ?? '').filter(Boolean) ?? []) ?? [];
  const online = reachability === 'unknown' ? null : reachability === 'online';
  if (exceptionDropReason({ message, online, sources })) return null;
  return { ...event, properties: { ...event.properties, online, connectivity_error: isConnectivityMessage(message) } };
}

function optionsFor(config: AnalyticsConfig, environment: AppEnvironment, startOptedOut: boolean): PostHogOptions {
  const development = environment === 'development';
  return {
    host: config.host,
    // Do not create person profiles for anonymous usage.
    personProfiles: 'identified_only',
    // Honour a saved opt-out from the very first event.
    defaultOptIn: !startOptedOut,
    captureAppLifecycleEvents: true,
    // Replay is off against a development client, like web's dev builds.
    enableSessionReplay: !development,
    sessionReplayConfig: {
      // Transcripts, diffs and code are on screen: mask text, inputs and images.
      maskAllTextInputs: true,
      maskAllImages: true,
      maskAllSandboxedViews: true,
      // Console lines and request URLs can carry content, so neither goes in a recording.
      captureLog: false,
      captureNetworkTelemetry: false,
    },
    // Exception autocapture is noisy against Metro; it runs in preview and production builds.
    errorTracking: development ? { autocapture: false } : {
      autocapture: { uncaughtExceptions: true, unhandledRejections: true, console: ['error'] },
    },
    before_send: beforeSend,
  };
}

interface ChoiceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
// Loaded on first use, like the theme preference: the native module is absent where no screen needs it, such as most tests.
function storage(): ChoiceStorage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@react-native-async-storage/async-storage') as { default: ChoiceStorage }).default;
}

/** Read the saved opt-out. A storage failure reads as not opted out, like web. */
export async function loadAnalyticsOptOut(): Promise<boolean> {
  try { optedOut = (await storage().getItem(OPT_OUT_KEY)) === 'true'; } catch { optedOut = false; }
  return optedOut;
}

/** Whether the person opted out of usage analytics and session replay on this device. */
export function getAnalyticsOptOut(): boolean {
  return optedOut;
}

/**
 * Initialise PostHog once. Resolves with the client, or null when analytics
 * is off. The opt-out is read before the client exists, so an opted-out
 * person sends nothing at all.
 */
export function initAnalytics(): Promise<PostHog | null> {
  if (initPromise) return initPromise;
  const config = analyticsConfigOf(configExtra());
  if (!config) {
    initPromise = Promise.resolve(null);
    return initPromise;
  }
  const environment = appEnvironmentOf(configExtra());
  initPromise = (async () => {
    const startOptedOut = await loadAnalyticsOptOut();
    const ph = new PostHog(config.key, optionsFor(config, environment, startOptedOut));
    client = ph;
    try { await ph.ready(); } catch { /* The client still queues events. */ }
    // The SDK also persists its own opt-out. Make it agree with the saved choice.
    if (optedOut && !ph.optedOut) await ph.optOut();
    else if (!optedOut && ph.optedOut) await ph.optIn();
    buildProperties = buildSuperProperties(environment);
    await ph.register(buildProperties);
    trackEvent('app_opened');
    return ph;
  })().catch(() => null);
  return initPromise;
}

/** The live client, for the touch-autocapture provider. Null until init finishes or when analytics is off. */
export function getAnalyticsClient(): PostHog | null {
  return client;
}

/**
 * Turn analytics and session replay off or on. Saves the choice and applies
 * it to the live client at once, like web.
 */
export async function setAnalyticsOptOut(next: boolean): Promise<void> {
  optedOut = next;
  try { await storage().setItem(OPT_OUT_KEY, String(next)); } catch { /* The live client still applies it. */ }
  if (!client) return;
  if (next) {
    // Stop replay first, so opting in later starts a new recording only when asked.
    await client.stopSessionRecording();
    await client.optOut();
  } else {
    await client.optIn();
    if (appEnvironmentOf(configExtra()) !== 'development') await client.startSessionRecording();
  }
}

/** Whether the device can reach the network, for the exception tags. */
export function setAnalyticsReachability(value: Reachability): void {
  reachability = value;
}

/** Attach properties to every later event, for slow-changing context such as the workspace. */
export function registerSuperProperties(properties: AnalyticsProperties): void {
  if (client) void client.register(properties);
}

/** Link later events to a person. The distinct id is the Supabase user id, as on web. */
export function identifyAnalyticsUser(distinctId: string, properties?: AnalyticsProperties): void {
  if (client) client.identify(distinctId, properties);
}

/** Clear the identity on sign-out. `reset()` also clears super properties, so the build ones go back. */
export function resetAnalyticsUser(): void {
  if (!client) return;
  client.reset();
  void client.register(buildProperties);
}

/** Capture a product event. Never pass titles, prompts, repository names or other content. */
export function trackEvent(event: string, properties?: AnalyticsProperties): void {
  if (client) client.capture(event, properties);
}

/** Record a screen view. `name` is the route pattern, never a path with ids. */
export function trackScreen(name: string): void {
  if (client) void client.screen(name);
}

/** Capture a caught exception, such as one an error boundary stopped. */
export function captureAnalyticsException(error: unknown, properties?: AnalyticsProperties): void {
  if (client) client.captureException(error, properties);
}

/**
 * The route pattern for expo-router segments: groups are dropped and dynamic
 * segments stay as written, so `['(drawer)', 'home']` is `/home` and
 * `['pulls', '[id]']` is `/pulls/[id]`. No ids reach PostHog.
 */
export function screenPattern(segments: readonly string[]): string {
  const parts = segments.filter((segment) => segment && !/^\(.*\)$/.test(segment) && segment !== 'index');
  return `/${parts.join('/')}`;
}

/** Test hook: forget the client and the saved state. */
export function resetAnalyticsForTests(): void {
  client = null;
  initPromise = null;
  optedOut = false;
  reachability = 'unknown';
  buildProperties = {};
}
