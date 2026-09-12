import { isIP } from 'node:net';

export const DEFAULT_POSTHOG_HOST = 'https://us.posthog.com';

const CLOUD_ORIGINS = [DEFAULT_POSTHOG_HOST, 'https://eu.posthog.com'];

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

/** Operator entries are trusted destinations, including private self-hosted instances. */
export function normalizeHost(host?: unknown): string {
  if (host != null && typeof host !== 'string') {
    throw new Error('PostHog host must be an exact HTTPS origin.');
  }
  const origin = exactOrigin(typeof host === 'string' ? host.trim() || DEFAULT_POSTHOG_HOST : DEFAULT_POSTHOG_HOST);
  const allowed = (process.env.POSTHOG_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => exactOrigin(value));
  if (!CLOUD_ORIGINS.includes(origin) && !allowed.includes(origin)) {
    throw new Error('PostHog host is not allowed. Ask the operator to configure POSTHOG_ALLOWED_ORIGINS.');
  }
  return origin;
}
