import {
  DEFAULT_MOBILE_RETURN_SCHEMES,
  INVALID_RETURN_TO_CODE,
  MOBILE_BILLING_RETURN_PATH,
  MOBILE_GITHUB_RETURN_PATH,
  MOBILE_LINEAR_RETURN_PATH,
  MOBILE_MCP_RETURN_PATH,
  MOBILE_POSTHOG_RETURN_PATH,
  MOBILE_SLACK_RETURN_PATH,
  type GitHubCallbackErrorReason,
  type MobileBillingReturnKind,
  type MobileBillingReturnResult,
} from '@talyn/shared';

/**
 * Where a browser flow started from the mobile app sends the person back.
 *
 * The mobile app passes its own URL base as `returnTo` (`talyn-mobile://`).
 * It is a caller-supplied redirect target, so it is accepted only when it is
 * EXACTLY one entry of the `MOBILE_RETURN_SCHEMES` allowlist: no path, no
 * host, no query, no pattern. The paths after it are ours. That keeps the
 * GitHub callback and the Polar redirects from turning into an open redirect,
 * the same rule `webApp.ts` applies to the web app.
 */

/** `scheme://` and nothing after it. The scheme grammar is RFC 3986 §3.1, lowercase only. */
const SCHEME_ONLY = /^[a-z][a-z0-9+.-]*:\/\/$/;

/** Schemes a browser treats as a web page or as script: never an app return. */
const REFUSED_SCHEMES = new Set(['http', 'https', 'javascript', 'data', 'file', 'blob', 'about', 'vbscript', 'ftp', 'ws', 'wss']);

function isAppScheme(entry: string): boolean {
  if (!SCHEME_ONLY.test(entry)) return false;
  return !REFUSED_SCHEMES.has(entry.slice(0, -3));
}

/**
 * The allowlist. Unset or blank means the defaults (the three app variants).
 * Entries are trimmed and lowercased (a scheme is case-insensitive); an
 * entry that is not exactly `scheme://` for an app scheme is dropped with a
 * warning rather than widening the list.
 */
export function mobileReturnSchemes(): readonly string[] {
  const raw = (process.env.MOBILE_RETURN_SCHEMES ?? '').trim();
  if (!raw) return DEFAULT_MOBILE_RETURN_SCHEMES;
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    if (!isAppScheme(entry)) {
      console.warn(`MOBILE_RETURN_SCHEMES: ignoring '${part.trim()}' (must be exactly 'scheme://').`);
      continue;
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * The allowlisted entry `value` names, or null. Exact, case-sensitive string
 * equality: `TALYN-MOBILE://`, `talyn-mobile:///`, `talyn-mobile://evil` and
 * ` talyn-mobile://` are all refused.
 */
export function validMobileReturn(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return mobileReturnSchemes().find((entry) => entry === value) ?? null;
}

export type ReturnToResult = { ok: true; returnTo: string | null } | { ok: false };

/**
 * Read an optional `returnTo` from a request body. Absent (`undefined` or
 * `null`) is fine and means "no mobile return"; anything else must be valid.
 */
export function parseReturnTo(value: unknown): ReturnToResult {
  if (value === undefined || value === null) return { ok: true, returnTo: null };
  const returnTo = validMobileReturn(value);
  return returnTo ? { ok: true, returnTo } : { ok: false };
}

/** The 400 body for a refused `returnTo`. */
export function invalidReturnToBody(): { success: false; code: string; error: string } {
  return {
    success: false,
    code: INVALID_RETURN_TO_CODE,
    error: 'returnTo is not an allowed app return address.',
  };
}

/** Build `${returnTo}${path}?…`. `returnTo` must already be allowlisted. */
function appUrl(returnTo: string, path: string, params: Record<string, string>): string {
  return `${returnTo}${path}?${new URLSearchParams(params).toString()}`;
}

/** Where the GitHub App callback finishes for a mobile flow. */
export function mobileGitHubReturnUrl(
  returnTo: string,
  outcome: { ok: true } | { ok: false; reason: GitHubCallbackErrorReason }
): string {
  return appUrl(
    returnTo,
    MOBILE_GITHUB_RETURN_PATH,
    outcome.ok ? { github: 'connected' } : { github: 'error', reason: outcome.reason }
  );
}

/** `{ <key>: 'error', message }`, the same pair the web Settings redirect carries. */
function errorParams(key: string, message: string): Record<string, string> {
  const text = message.trim();
  return text ? { [key]: 'error', message: text } : { [key]: 'error' };
}

/** Where the Slack OAuth callback finishes for a mobile flow. */
export function mobileSlackReturnUrl(
  returnTo: string,
  outcome: { ok: true; flow: 'install' | 'link' } | { ok: false; message: string }
): string {
  return appUrl(
    returnTo,
    MOBILE_SLACK_RETURN_PATH,
    outcome.ok ? { slack: outcome.flow === 'install' ? 'installed' : 'linked' } : errorParams('slack', outcome.message)
  );
}

/** Where the Linear OAuth callback finishes for a mobile flow. */
export function mobileLinearReturnUrl(returnTo: string, outcome: { ok: true } | { ok: false; message: string }): string {
  return appUrl(returnTo, MOBILE_LINEAR_RETURN_PATH, outcome.ok ? { linear: 'connected' } : errorParams('linear', outcome.message));
}

/** Where the PostHog Code OAuth callback finishes for a mobile flow. */
export function mobilePostHogReturnUrl(
  returnTo: string,
  outcome: { ok: true } | { ok: false; message: string }
): string {
  return appUrl(
    returnTo,
    MOBILE_POSTHOG_RETURN_PATH,
    outcome.ok ? { posthog: 'connected' } : errorParams('posthog', outcome.message)
  );
}

/**
 * Where an MCP server sign-in finishes for a mobile flow. The web callback
 * page sends the browser here; the vendor's text stays out, because the app
 * re-reads the server's grant status (which carries it) after the return.
 */
export function mobileMcpReturnUrl(returnTo: string, outcome: { ok: boolean }): string {
  return appUrl(returnTo, MOBILE_MCP_RETURN_PATH, { mcp: outcome.ok ? 'connected' : 'error' });
}

/** The app deep link a billing return ends on. */
export function mobileBillingReturnUrl(
  returnTo: string,
  kind: MobileBillingReturnKind,
  result: MobileBillingReturnResult
): string {
  return appUrl(returnTo, MOBILE_BILLING_RETURN_PATH, { kind, result });
}

/** Where the billing bounce route lives, under the API origin. */
export const MOBILE_BILLING_BOUNCE_PATH = '/api/v1/billing/mobile-return';

/**
 * The backend's own public origin, or null when this deployment cannot say.
 *
 * Polar validates a checkout's success and return URLs as http(s) URLs, so it
 * refuses `talyn-mobile://…`. A mobile checkout therefore goes back through
 * {@link MOBILE_BILLING_BOUNCE_PATH}, which 302s to the app. That needs our
 * public origin: `TALYN_PUBLIC_API_URL`, otherwise the origin of one of the
 * backend's own OAuth callbacks (full public URLs under `/api/v1/`), the same
 * sources `talynMcpPublicUrl` reads. https only, except a localhost origin
 * for local development.
 */
export function publicApiOrigin(): string | null {
  const explicit = (process.env.TALYN_PUBLIC_API_URL ?? '').trim();
  const candidates = explicit
    ? [{ raw: explicit, fromCallback: false }]
    : ['POSTHOG_OAUTH_REDIRECT_URI', 'SLACK_OAUTH_REDIRECT_URI'].map((name) => ({
        raw: (process.env[name] ?? '').trim(),
        fromCallback: true,
      }));
  for (const { raw, fromCallback } of candidates) {
    if (!raw) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (fromCallback && !parsed.pathname.startsWith('/api/v1/')) continue;
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) continue;
    if (parsed.username || parsed.password) continue;
    return parsed.origin;
  }
  return null;
}

/**
 * The http(s) URL Polar redirects to for a mobile billing return, or null
 * when the backend does not know its public origin (the caller then keeps
 * the web redirects, and the app re-polls on foreground).
 */
export function mobileBillingBounceUrl(
  returnTo: string,
  kind: MobileBillingReturnKind,
  result: MobileBillingReturnResult
): string | null {
  const origin = publicApiOrigin();
  if (!origin) return null;
  const url = new URL(MOBILE_BILLING_BOUNCE_PATH, origin);
  url.searchParams.set('to', returnTo);
  url.searchParams.set('kind', kind);
  url.searchParams.set('result', result);
  return url.toString();
}
