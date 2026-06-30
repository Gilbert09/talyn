import { createSign } from 'node:crypto';
import { fetchWithTimeout } from './github.js';
import { debugBus } from './debugBus.js';

/**
 * GitHub App authentication.
 *
 * Two token families, per the hybrid auth model:
 *   - INSTALLATION tokens (this module) — act as the App, mint on demand from a
 *     signed App JWT, expire in ~1h, cached + refreshed before expiry. These do
 *     all repo/PR/checks reads and back the webhook pipeline. No per-user rate
 *     limit on the hot path (an installation has its own 5000/h bucket).
 *   - USER-to-server tokens (`ghu_`) — minted by {@link exchangeUserCode} during
 *     the install OAuth redirect, stored encrypted on the workspace integration
 *     row, and used only to resolve the viewer's login + authored/review
 *     membership. Those live in github.ts alongside the existing token helpers.
 *
 * Everything degrades to "not configured" when the App env vars are unset, so a
 * dev box on plain OAuth keeps working.
 */

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Refresh an installation token once it's within this window of expiry. */
const REFRESH_SKEW_MS = 5 * 60_000;

function appId(): string {
  return process.env.GITHUB_APP_ID || '';
}

function appClientId(): string {
  return process.env.GITHUB_APP_CLIENT_ID || '';
}

function appClientSecret(): string {
  return process.env.GITHUB_APP_CLIENT_SECRET || '';
}

function appSlug(): string {
  return process.env.GITHUB_APP_SLUG || '';
}

/**
 * The App private key as PEM. Stored as base64 in `GITHUB_APP_PRIVATE_KEY` to
 * survive single-line env vars; a raw PEM (already containing newlines) is
 * accepted too.
 */
export function getAppPrivateKey(): string | null {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) return null;
  if (raw.includes('BEGIN') && raw.includes('PRIVATE KEY')) return raw;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return decoded.includes('PRIVATE KEY') ? decoded : null;
  } catch {
    return null;
  }
}

export function isGitHubAppConfigured(): boolean {
  return Boolean(appId() && getAppPrivateKey());
}

/** Raised when an installation token can't be minted because the install is gone/suspended. */
export class InstallationUnavailableError extends Error {
  constructor(
    public readonly installationId: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'InstallationUnavailableError';
  }
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign a short-lived App JWT (RS256). `iss` is the App id; GitHub allows up to
 * 10 min expiry. `nowSeconds` is injectable for tests. Throws if the App isn't
 * configured.
 */
export function signAppJwt(nowSeconds = Math.floor(Date.now() / 1000)): string {
  const key = getAppPrivateKey();
  const iss = appId();
  if (!key || !iss) throw new Error('GitHub App not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)');
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // 60s clock-skew allowance on iat, per GitHub's guidance.
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(key));
  return `${signingInput}.${signature}`;
}

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

const installationTokens = new Map<string, CachedInstallationToken>();
// Coalesce concurrent mints for the same installation into one HTTP call.
const inFlightMints = new Map<string, Promise<string>>();

/**
 * A valid installation token for `installationId`, minting (or refreshing) via
 * the App JWT as needed. Cached until ~5 min before expiry. Concurrent callers
 * share one in-flight mint. Throws {@link InstallationUnavailableError} on
 * 401/404 (suspended/removed install) so callers can mark it.
 */
export async function getInstallationToken(installationId: string): Promise<string> {
  const cached = installationTokens.get(installationId);
  if (cached && cached.expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
    return cached.token;
  }
  const existing = inFlightMints.get(installationId);
  if (existing) return existing;

  const mint = mintInstallationToken(installationId).finally(() => {
    inFlightMints.delete(installationId);
  });
  inFlightMints.set(installationId, mint);
  return mint;
}

async function mintInstallationToken(installationId: string): Promise<string> {
  const jwt = signAppJwt();
  const url = `${GITHUB_API_URL}/app/installations/${installationId}/access_tokens`;
  const startedAt = Date.now();
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'Talyn',
    },
  });
  debugBus.recordHttp({
    service: 'github',
    method: 'POST',
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
    ok: response.ok,
    ...(response.ok ? {} : { error: `mint installation token: ${response.statusText}` }),
  });
  if (response.status === 401 || response.status === 404) {
    installationTokens.delete(installationId);
    throw new InstallationUnavailableError(
      installationId,
      response.status,
      `installation ${installationId} unavailable (${response.status})`,
    );
  }
  if (!response.ok) {
    throw new Error(`Failed to mint installation token: ${response.status} ${response.statusText}`);
  }
  const data = JSON.parse(response.bodyText) as { token: string; expires_at: string };
  const expiresAtMs = new Date(data.expires_at).getTime();
  installationTokens.set(installationId, { token: data.token, expiresAtMs });
  return data.token;
}

/** Drop a cached installation token (e.g. after a 401 on a data-plane call). */
export function clearInstallationToken(installationId: string): void {
  installationTokens.delete(installationId);
}

export interface InstallationInfo {
  installationId: string;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

/** App-JWT-authenticated read of an installation's account + suspension state. */
export async function fetchInstallation(installationId: string): Promise<InstallationInfo> {
  const jwt = signAppJwt();
  const url = `${GITHUB_API_URL}/app/installations/${installationId}`;
  const startedAt = Date.now();
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'Talyn',
    },
  });
  debugBus.recordHttp({
    service: 'github',
    method: 'GET',
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
    ok: response.ok,
    ...(response.ok ? {} : { error: `fetch installation: ${response.statusText}` }),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch installation ${installationId}: ${response.statusText}`);
  }
  const data = JSON.parse(response.bodyText) as {
    account?: { login?: string; type?: string };
    suspended_at?: string | null;
  };
  return {
    installationId,
    accountLogin: data.account?.login ?? 'unknown',
    accountType: data.account?.type ?? 'User',
    suspended: Boolean(data.suspended_at),
  };
}

/**
 * Every repo full-name the installation can access (the App's selected-repo
 * allowlist), via the installation token. Paginated.
 */
export async function fetchInstallationRepos(installationId: string): Promise<string[]> {
  const token = await getInstallationToken(installationId);
  const out: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const url = `${GITHUB_API_URL}/installation/repositories?per_page=100&page=${page}`;
    const startedAt = Date.now();
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${token}`,
        'User-Agent': 'Talyn',
      },
    });
    debugBus.recordHttp({
      service: 'github',
      method: 'GET',
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ok: response.ok,
      ...(response.ok ? {} : { error: `installation repos: ${response.statusText}` }),
    });
    if (!response.ok) {
      throw new Error(`Failed to list installation repos: ${response.statusText}`);
    }
    const data = JSON.parse(response.bodyText) as {
      repositories?: Array<{ full_name: string }>;
    };
    const repos = data.repositories ?? [];
    out.push(...repos.map((r) => r.full_name));
    if (repos.length < 100) break;
  }
  return out;
}

/**
 * A user-to-server token grant. When the App has "Expire user authorization
 * tokens" enabled, `refreshToken` + `expiresInSec` are present and the token
 * must be rotated before it expires (~8h); otherwise the token is long-lived
 * and those fields are absent.
 */
export interface UserTokenGrant {
  access_token: string;
  token_type: string;
  scope: string;
  /** Seconds until the access token expires (only when expiry is enabled). */
  expiresInSec?: number;
  /** Refresh token to rotate with (only when expiry is enabled). */
  refreshToken?: string;
  /** Seconds until the refresh token itself expires (~6 months). */
  refreshTokenExpiresInSec?: number;
}

/** Raised when a user-token refresh fails (refresh token expired/revoked → user must re-auth). */
export class UserTokenRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserTokenRefreshError';
  }
}

function parseUserTokenResponse(bodyText: string, context: string): UserTokenGrant {
  const data = JSON.parse(bodyText) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (data.error || !data.access_token) {
    throw new Error(`GitHub App OAuth error (${context}): ${data.error_description || data.error || 'no token'}`);
  }
  return {
    access_token: data.access_token,
    token_type: data.token_type || 'bearer',
    scope: data.scope || '',
    expiresInSec: data.expires_in,
    refreshToken: data.refresh_token,
    refreshTokenExpiresInSec: data.refresh_token_expires_in,
  };
}

/**
 * Exchange the OAuth `code` from the install redirect for a user-to-server
 * token. Same token endpoint as classic OAuth, but with the App's client
 * credentials — yields a `ghu_` token scoped to the user (plus a `ghr_` refresh
 * token when token expiry is enabled on the App).
 */
export async function exchangeUserCode(code: string): Promise<UserTokenGrant> {
  const clientId = appClientId();
  const clientSecret = appClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error('GitHub App OAuth not configured (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET)');
  }
  const startedAt = Date.now();
  const response = await fetchWithTimeout(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  debugBus.recordHttp({
    service: 'github',
    method: 'POST',
    url: GITHUB_TOKEN_URL,
    status: response.status,
    durationMs: Date.now() - startedAt,
    ok: response.ok,
    ...(response.ok ? {} : { error: `app user token exchange: ${response.statusText}` }),
  });
  if (!response.ok) {
    throw new Error(`GitHub App user token exchange failed: ${response.statusText}`);
  }
  return parseUserTokenResponse(response.bodyText, 'exchange');
}

/**
 * Rotate an expiring user-to-server token using its refresh token. GitHub
 * returns a fresh access token AND a fresh refresh token (rotation) — the
 * caller MUST persist the new refresh token. Throws {@link UserTokenRefreshError}
 * when the refresh token is itself expired/revoked (user must re-authorize).
 */
export async function refreshUserToken(refreshToken: string): Promise<UserTokenGrant> {
  const clientId = appClientId();
  const clientSecret = appClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error('GitHub App OAuth not configured (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET)');
  }
  const startedAt = Date.now();
  const response = await fetchWithTimeout(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  debugBus.recordHttp({
    service: 'github',
    method: 'POST',
    url: GITHUB_TOKEN_URL,
    status: response.status,
    durationMs: Date.now() - startedAt,
    ok: response.ok,
    ...(response.ok ? {} : { error: `app user token refresh: ${response.statusText}` }),
  });
  if (!response.ok) {
    throw new UserTokenRefreshError(`user token refresh failed: ${response.status} ${response.statusText}`);
  }
  try {
    return parseUserTokenResponse(response.bodyText, 'refresh');
  } catch (err) {
    // A 200 with an `error` body (e.g. bad_refresh_token) means the refresh
    // token is dead — surface as the typed error so the caller prompts re-auth.
    throw new UserTokenRefreshError(err instanceof Error ? err.message : String(err));
  }
}

/** The URL that starts a fresh App installation (+ user OAuth) with our state. */
export function buildInstallUrl(state: string): string {
  const slug = appSlug();
  if (!slug) throw new Error('GITHUB_APP_SLUG not configured');
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

/**
 * The user-authorization URL. Unlike the install URL, this ALWAYS runs the OAuth
 * authorize step and redirects to the App's callback with `code` + `state` —
 * whether or not the App is already installed (the install URL dead-ends on the
 * "configure" page for an existing install). This is what the connect button
 * uses; the install itself is a one-time per-account action the user does on
 * GitHub. Omits redirect_uri so GitHub uses the App's configured callback.
 */
export function buildUserAuthUrl(state: string): string {
  const clientId = appClientId();
  if (!clientId) throw new Error('GITHUB_APP_CLIENT_ID not configured');
  return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}`;
}

/** The page where a user manages which repos the App can access (install / add repos). */
export function appInstallationsPageUrl(): string {
  const slug = appSlug();
  return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : 'https://github.com/settings/installations';
}

export interface UserInstallationSummary {
  installationId: string;
  accountLogin: string;
  accountType: string;
  /** True when GitHub has suspended the install (no token can be minted for it). */
  suspended: boolean;
  /** Whether the App is scoped to all of the account's repos or a hand-picked set. */
  repositorySelection: 'all' | 'selected';
}

/**
 * Every installation of this App that the authorizing user can access, via the
 * user-to-server token. The authorize flow gives us a user token but no
 * `installation_id`, so this is how we discover which account(s) the user
 * installed the App on (a user can have it on their personal account + orgs).
 */
export async function fetchUserInstallations(userToken: string): Promise<UserInstallationSummary[]> {
  const out: UserInstallationSummary[] = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${GITHUB_API_URL}/user/installations?per_page=100&page=${page}`;
    const startedAt = Date.now();
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${userToken}`,
        'User-Agent': 'Talyn',
      },
    });
    debugBus.recordHttp({
      service: 'github',
      method: 'GET',
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ok: response.ok,
      ...(response.ok ? {} : { error: `user installations: ${response.statusText}` }),
    });
    if (!response.ok) {
      throw new Error(`Failed to list user installations: ${response.statusText}`);
    }
    const data = JSON.parse(response.bodyText) as {
      installations?: Array<{
        id: number;
        account?: { login?: string; type?: string };
        suspended_at?: string | null;
        repository_selection?: string;
      }>;
    };
    const insts = data.installations ?? [];
    for (const i of insts) {
      out.push({
        installationId: String(i.id),
        accountLogin: i.account?.login ?? 'unknown',
        accountType: i.account?.type ?? 'User',
        suspended: Boolean(i.suspended_at),
        repositorySelection: i.repository_selection === 'selected' ? 'selected' : 'all',
      });
    }
    if (insts.length < 100) break;
  }
  return out;
}

/** Test helper — clear the in-memory installation-token cache. */
export function _resetInstallationTokenCache(): void {
  installationTokens.clear();
  inFlightMints.clear();
}
