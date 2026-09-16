import { getPoolDbClient, isRealPostgres } from '../../db/client.js';
import { withBlockingAdvisoryLock } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { fetchWithTimeout } from '../httpTimeout.js';
import { decryptString, encryptString, isEncryptedEnvelope } from '../tokenCrypto.js';
import type { EncryptedEnvelope } from '../tokenCrypto.js';

/**
 * The Claude-subscription credential lifecycle for Talyn Fleet.
 *
 * # Why this one CAN run in a browser, when Codex cannot
 *
 * `codexOauth.ts` beside this is its twin, and the two should be diffable — but
 * they differ on the one point that decides the product. OpenAI's Codex client
 * registers `http://localhost:1455/auth/callback`, a loopback a hosted backend
 * can never be, so its authorize leg has to run in the desktop main process and
 * `apps/web` pastes a token instead.
 *
 * Anthropic's client redirects to a page ANTHROPIC hosts
 * (`/oauth/code/callback`), which displays a code for the user to copy. Nothing
 * listens on a port, so the same flow works unchanged on the desktop and on the
 * web: send the browser to the authorize URL, take the code back, exchange it
 * here. That is why this module owns the exchange as well as the refresh, and
 * why it needs no `main/` counterpart.
 *
 * # What it replaces
 *
 * `claude setup-token` and a paste. That asked a user to open a terminal, run a
 * CLI and copy a raw secret into a text box — and it left us holding a bare
 * access token: no refresh, no expiry, no way to tell an expired grant from a
 * revoked one. A fleet run that outlived it failed at the gateway with nothing
 * to say. The Console-key path (`sk-ant-api…`) stays, because a workspace that
 * wants metered billing has no subscription to sign in to.
 *
 * # What must be on the server
 *
 * REFRESH, for the reason yas's `anthropic_oauth.go` gives: a subscription
 * access token lives hours, a loop fires at 03:00 against a token minted
 * yesterday, and the run cannot renew for itself because it never sees the
 * credential — the host's proxy injects it. A token only the laptop could
 * refresh would mean unattended work stopping every night.
 */

/**
 * Claude Code's own OAuth client, and the page Anthropic redirects to.
 *
 * Public by construction: a PKCE client has no secret, and this id travels in
 * the URL the browser is sent to. Read out of Claude Code itself rather than
 * guessed — a mismatched `redirect_uri` between the authorize and the token
 * call is an `invalid_grant` with nothing in it that says why.
 */
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
export const CLAUDE_AUTHORIZE_URL = 'https://platform.claude.com/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/**
 * What the authorize leg asks for, and what a renewal carries forward.
 *
 * The two differ, and deliberately: `org:create_api_key` is a console-account
 * power that a subscription renewal has no use for, and a renewal asking for
 * more than it was granted is a renewal that can be refused. Anthropic's own
 * client draws the same distinction.
 */
export const CLAUDE_AUTHORIZE_SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code ' +
  'user:mcp_servers user:file_upload';
export const CLAUDE_REFRESH_SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/** Refresh this long before expiry, so a dispatch never races the clock. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class ClaudeOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeOAuthError';
  }
}

/**
 * A grant Anthropic will never honour again.
 *
 * Distinguished from a transport failure because the ANSWER differs: a network
 * error is worth retrying on the next dispatch, and this is not — only the user
 * can restore it, by signing in again. Reporting the two alike would have the
 * fleet retrying a dead grant every thirty seconds forever.
 */
export class ClaudeReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeReauthRequiredError';
  }
}

/** The stored shape. Mirrors CodexOAuthCredential, minus the account id. */
export interface ClaudeOAuthCredential {
  accessTokenEnc: EncryptedEnvelope;
  refreshTokenEnc: EncryptedEnvelope;
  /** ISO expiry of the access token, so a refresh happens before a run. */
  expiresAt: string;
  /** Set when a refresh came back `invalid_grant`. Nothing retries while set. */
  reauthRequiredAt?: string;
}

export interface ClaudeTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

function expiryFrom(seconds: number | undefined): string {
  // An absent `expires_in` is treated as an hour rather than as forever: the
  // margin then makes the next dispatch refresh, which is the safe direction.
  const ttl = typeof seconds === 'number' && seconds > 0 ? seconds : 3600;
  return new Date(Date.now() + ttl * 1000).toISOString();
}

function isExpiring(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at - Date.now() < REFRESH_MARGIN_MS;
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at <= Date.now();
}

/**
 * The code Anthropic's callback page shows is `code#state`.
 *
 * Split here rather than in the UI: a user copying from that page brings the
 * whole string, and asking them to trim it is an instruction that will be got
 * wrong. A plain code with no `#` is accepted unchanged.
 */
export function splitPastedCode(pasted: string): { code: string; state?: string } {
  const trimmed = pasted.trim();
  const hash = trimmed.indexOf('#');
  if (hash === -1) return { code: trimmed };
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
}

/** Build the URL the browser is sent to. PKCE, so the verifier stays with us. */
export function buildAuthorizeUrl(params: {
  codeChallenge: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_AUTHORIZE_SCOPE,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  return `${CLAUDE_AUTHORIZE_URL}?${q.toString()}`;
}

/**
 * Read a failure out of `error`, whichever of TWO shapes it arrived in.
 *
 * Anthropic's token endpoint answers in both, depending on what went wrong: the
 * OAuth one from RFC 6749 §5.2, `{"error":"invalid_grant","error_description":…}`,
 * and Anthropic's own API envelope, `{"error":{"type":"rate_limit_error",
 * "message":…}}`. A live probe of the endpoint returned the second.
 *
 * Reading only the string shape is not merely untidy here, and that is the
 * point: `error` would be an OBJECT, `error === 'invalid_grant'` would be
 * quietly false, and a dead grant would be classified transient and retried on
 * every dispatch forever — the one failure this module exists to tell apart.
 * yas's `claudeOAuthError` learned the same lesson from the same probe.
 */
function parseOAuthError(body: string): { error?: string; description?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const { error, error_description: description } = parsed as {
    error?: unknown;
    error_description?: string;
  };
  if (typeof error === 'string') return { error, description };
  if (error && typeof error === 'object') {
    const envelope = error as { type?: string; message?: string };
    return { error: envelope.type, description: envelope.message ?? description };
  }
  return { description };
}

/**
 * POST Anthropic's token endpoint as a public client (PKCE, no secret).
 *
 * `invalid_grant` is the one error worth distinguishing: per RFC 6749 it is the
 * server saying this grant will never work again.
 */
export async function postToken(params: Record<string, string>): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  // JSON, not form-encoding: Anthropic's token endpoint takes a JSON body, as
  // yas's anthropic_oauth.go does and as Claude Code does. Sending
  // `application/x-www-form-urlencoded` here — the shape the Codex twin uses —
  // is refused.
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    CLAUDE_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(params),
    },
    { label: 'claude-oauth-token' },
  );
  debugBus.recordHttp({
    service: 'claude_oauth',
    method: 'POST',
    url: CLAUDE_TOKEN_URL,
    status: res.status,
    durationMs: Date.now() - startedAt,
    ok: res.ok,
    bytes: res.bodyText.length,
    // On a failure the body carries an OAuth error code, never a token.
    ...(res.ok ? {} : { error: res.bodyText.slice(0, 300) }),
  });

  if (!res.ok) {
    const { error, description } = parseOAuthError(res.bodyText);
    const detail = description || error || `HTTP ${res.status}`;
    // `invalid_client` joins `invalid_grant` for the reason the Codex twin
    // gives: both mean this credential will never work again, and retrying
    // either one is a loop nobody watches.
    if (error === 'invalid_grant' || error === 'invalid_client') {
      throw new ClaudeReauthRequiredError(
        `Anthropic rejected the stored sign-in (${detail}) — sign in to Claude again.`,
      );
    }
    throw new ClaudeOAuthError(`Claude token request failed (${res.status}): ${detail}`);
  }

  let parsed: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(res.bodyText) as typeof parsed;
  } catch {
    throw new ClaudeOAuthError('Claude token endpoint returned a body that is not JSON.');
  }
  if (!parsed.access_token) {
    throw new ClaudeOAuthError('Claude token endpoint returned no access token.');
  }
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_in: parsed.expires_in,
  };
}

/** Exchange a pasted authorization code for a credential to store. */
export async function exchangeCode(input: {
  code: string;
  codeVerifier: string;
  state?: string;
}): Promise<ClaudeOAuthCredential> {
  const body = await postToken({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: CLAUDE_REDIRECT_URI,
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: input.codeVerifier,
    ...(input.state ? { state: input.state } : {}),
  });
  if (!body.refresh_token) {
    // Without one we are back where the paste flow was: a token that expires
    // in hours and nothing to renew it with. Better to refuse the connection
    // than to store a credential that will stop working overnight.
    throw new ClaudeOAuthError(
      'Claude returned no refresh token, so the connection would stop working within hours.',
    );
  }
  return {
    accessTokenEnc: encryptString(body.access_token),
    refreshTokenEnc: encryptString(body.refresh_token),
    expiresAt: expiryFrom(body.expires_in),
  };
}

const inflight = new Map<string, Promise<ClaudeTokenPair>>();

/** Test hook — the in-process half of the single-flight. */
export function _resetClaudeOauthInflight(): void {
  inflight.clear();
}

export interface ClaudeCredentialStore {
  read: (workspaceId: string) => Promise<ClaudeOAuthCredential | undefined>;
  patch: (workspaceId: string, next: ClaudeOAuthCredential) => Promise<void>;
}

/**
 * The freshest access token for this workspace, refreshing if it is close to
 * expiry. Null when there is nothing usable and the user must sign in again.
 */
export async function resolveClaudeAccessToken(
  workspaceId: string,
  stored: ClaudeOAuthCredential | undefined,
  store: ClaudeCredentialStore,
): Promise<string | null> {
  if (!stored || !isEncryptedEnvelope(stored.accessTokenEnc)) return null;
  if (stored.reauthRequiredAt) {
    console.warn(
      `[claude] workspace ${workspaceId.slice(0, 8)} needs to reconnect Claude — ` +
        'the stored authorization was rejected, so nothing is being retried.',
    );
    return null;
  }
  if (!isExpiring(stored.expiresAt)) return decryptString(stored.accessTokenEnc);

  const existing = inflight.get(workspaceId);
  if (existing) return (await existing).accessToken;

  const attempt = refreshWithLock(workspaceId, stored, store).finally(() =>
    inflight.delete(workspaceId),
  );
  inflight.set(workspaceId, attempt);
  try {
    return (await attempt).accessToken;
  } catch (err) {
    // A PREEMPTIVE refresh that failed transiently must not fail the caller:
    // we refresh five minutes early, so the token in hand is normally still
    // good. Not for a genuinely expired token, and not for a dead grant —
    // there, handing back the old one only moves the failure into the guest.
    if (err instanceof ClaudeReauthRequiredError) throw err;
    if (!isExpired(stored.expiresAt)) {
      console.warn(
        `[claude] preemptive refresh for workspace ${workspaceId.slice(0, 8)} failed; ` +
          `using the token in hand (${err instanceof Error ? err.message : String(err)})`,
      );
      return decryptString(stored.accessTokenEnc);
    }
    throw err;
  }
}

async function refreshWithLock(
  workspaceId: string,
  hint: ClaudeOAuthCredential,
  store: ClaudeCredentialStore,
): Promise<ClaudeTokenPair> {
  const run = async (): Promise<ClaudeTokenPair> => {
    // Re-read INSIDE the lock: the instance that held it before us may already
    // have rotated the pair, and replaying a spent refresh token is exactly
    // what `invalid_grant` is for.
    const fresh = (await store.read(workspaceId)) ?? hint;
    if (fresh.reauthRequiredAt) {
      throw new ClaudeReauthRequiredError(
        'Sign in to Claude again — the stored authorization was rejected.',
      );
    }
    if (!isExpiring(fresh.expiresAt)) {
      return {
        accessToken: decryptString(fresh.accessTokenEnc),
        refreshToken: decryptString(fresh.refreshTokenEnc),
        expiresAt: fresh.expiresAt,
      };
    }
    return performRefresh(workspaceId, fresh, store);
  };

  // The lock is the CROSS-INSTANCE half of the single-flight; the in-process
  // map is the other. Skipped off real Postgres: pglite is one WASM connection
  // whose `transaction()` takes an exclusive mutex, and `run`'s own queries go
  // through the same client, so wrapping it self-deadlocks. Same shape as
  // codexOauth.ts and posthogCode/oauth.ts.
  if (!isRealPostgres()) return run();
  return withBlockingAdvisoryLock(getPoolDbClient(), `claude-oauth-refresh:${workspaceId}`, run);
}

async function performRefresh(
  workspaceId: string,
  current: ClaudeOAuthCredential,
  store: ClaudeCredentialStore,
): Promise<ClaudeTokenPair> {
  const body = await postToken({
    grant_type: 'refresh_token',
    refresh_token: decryptString(current.refreshTokenEnc),
    client_id: CLAUDE_CLIENT_ID,
    scope: CLAUDE_REFRESH_SCOPE,
  });

  const accessToken = body.access_token;
  // Anthropic ROTATES the refresh token, but a response without a new one means
  // "keep the one you have" rather than a failure — dropping it would strand
  // the workspace on an access token it can never renew. yas learned this one.
  const refreshToken = body.refresh_token ?? decryptString(current.refreshTokenEnc);
  const expiresAt = expiryFrom(body.expires_in);

  await store.patch(workspaceId, {
    accessTokenEnc: encryptString(accessToken),
    refreshTokenEnc: encryptString(refreshToken),
    expiresAt,
  });

  return { accessToken, refreshToken, expiresAt };
}
