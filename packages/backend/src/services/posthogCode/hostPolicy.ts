import { isIP } from 'node:net';

export const DEFAULT_POSTHOG_HOST = 'https://us.posthog.com';

// `app.posthog.com` is PostHog's legacy US cloud domain. Workspaces connected
// before the regional split still store it, and a cloud user should not need an
// operator to set an env var to keep working. It is PostHog's own host, so it
// carries the same trust as the two regional ones.
const CLOUD_ORIGINS = [DEFAULT_POSTHOG_HOST, 'https://eu.posthog.com', 'https://app.posthog.com'];

/** A host that is well-formed but not on the allowlist. Distinct so callers can say so. */
export class PostHogHostNotAllowedError extends Error {
  constructor(readonly host: string) {
    super('PostHog host is not allowed. Ask the operator to configure POSTHOG_ALLOWED_ORIGINS.');
    this.name = 'PostHogHostNotAllowedError';
  }
}

function exactOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PostHog host must be an exact HTTPS origin.');
  }
  // Reject URL parser rewrites, including encoded hosts and alternate IP forms.
  if (
    url.protocol !== 'https:' ||
    url.username || url.password || url.search || url.hash ||
    (!isIP(url.hostname.replace(/^\[|\]$/g, '')) &&
      !url.hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error('PostHog host must be an exact HTTPS origin.');
  }
  return url.origin;
}

/**
 * The operator-configured origins, parsed once.
 *
 * Parsing per call made one malformed entry a total PostHog outage for every
 * workspace, including the ones on a cloud host — discovered at request time,
 * not at boot. A bad entry is now dropped with a warning, and
 * {@link assertAllowedOriginsConfig} turns it into a loud boot failure.
 */
let allowedOriginsCache: { raw: string; origins: string[] } | null = null;

function allowedOrigins(): string[] {
  const raw = process.env.POSTHOG_ALLOWED_ORIGINS ?? '';
  if (allowedOriginsCache?.raw === raw) return allowedOriginsCache.origins;
  const origins: string[] = [];
  for (const entry of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    try {
      origins.push(exactOrigin(entry));
    } catch {
      console.warn(
        `[posthog] ignoring malformed POSTHOG_ALLOWED_ORIGINS entry "${entry}" — ` +
        'each entry must be an exact HTTPS origin, e.g. https://posthog.example.com'
      );
    }
  }
  allowedOriginsCache = { raw, origins };
  return origins;
}

/**
 * Validate `POSTHOG_ALLOWED_ORIGINS` at boot. Returns the malformed entries.
 * A typo should be visible in the boot log, not as a refused request an hour later.
 */
export function assertAllowedOriginsConfig(): string[] {
  const malformed: string[] = [];
  for (const entry of (process.env.POSTHOG_ALLOWED_ORIGINS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean)) {
    try {
      exactOrigin(entry);
    } catch {
      malformed.push(entry);
    }
  }
  return malformed;
}

/** Test helper — drop the parsed allowlist between cases. */
export function _resetAllowedOriginsCache(): void {
  allowedOriginsCache = null;
}

/** Operator entries are trusted destinations, including private self-hosted instances. */
export function normalizeHost(host?: unknown): string {
  if (host != null && typeof host !== 'string') {
    throw new Error('PostHog host must be an exact HTTPS origin.');
  }
  const origin = exactOrigin(typeof host === 'string' ? host.trim() || DEFAULT_POSTHOG_HOST : DEFAULT_POSTHOG_HOST);
  if (!CLOUD_ORIGINS.includes(origin) && !allowedOrigins().includes(origin)) {
    throw new PostHogHostNotAllowedError(origin);
  }
  return origin;
}
