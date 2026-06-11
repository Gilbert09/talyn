import { EventEmitter } from 'events';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { and, eq, inArray } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import {
  integrations as integrationsTable,
  workspaces as workspacesTable,
  users as usersTable,
} from '../db/schema.js';
import {
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from './tokenCrypto.js';
import { debugBus, redactUrl } from './debugBus.js';
import {
  githubRateGate,
  GitHubRateLimitError,
  parseRateLimitResponse,
} from './githubRateGate.js';

// GitHub OAuth configuration. Set via environment variables in production.
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_REDIRECT_URI =
  process.env.GITHUB_REDIRECT_URI || 'http://localhost:4747/api/v1/github/callback';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// `workflow` is needed to merge PRs in large repos: before allowing a merge,
// GitHub gate-checks whether the PR modifies `.github/workflows/**` and, if the
// token lacks the `workflow` scope, that check can time out on big diffs —
// surfacing as "403 … Unable to determine if workflow can be created or updated
// due to timeout; `workflows` scope may be required" even when no workflow file
// is touched. Granting the scope removes the gate-check entirely.
const GITHUB_SCOPES = ['repo', 'workflow', 'read:user', 'read:org'];

/**
 * Hard ceiling on any single GitHub HTTP call. Node's global `fetch` (undici)
 * has NO default timeout, so a stalled socket leaves the awaiting caller hung
 * forever — which once wedged the merge-queue tick: its `ticking` guard is only
 * released in a `finally`, so an indefinitely-pending merge request froze the
 * whole loop (no merges, no errors). Abort every request after this so a hung
 * connection surfaces as a throw the caller can record/retry, never a hang.
 */
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A fully-consumed GitHub response. The body is already read as text so no
 * caller can hang on a stalled body stream after the timeout was disarmed.
 */
export interface TimedResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  bodyText: string;
}

/**
 * `fetch` with a hard timeout via `AbortController`, covering the WHOLE
 * request — headers AND body. An earlier version cleared the abort timer as
 * soon as `fetch` resolved (headers in), leaving the subsequent
 * `response.json()` unbounded; a merge response whose body stalled hung the
 * merge-queue tick for 5+ minutes in prod while the PR was already merged on
 * GitHub. The body is consumed here, inside the timer, and returned as text.
 *
 * On timeout it throws a descriptive error (not a bare `AbortError`) so
 * callers log something useful. The `signal` is applied AFTER the spread so
 * it always wins.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = GITHUB_REQUEST_TIMEOUT_MS
): Promise<TimedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: response.headers,
      bodyText,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`GitHub request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a JSON body read by {@link fetchWithTimeout}; empty body → undefined. */
function parseJsonBody<T>(bodyText: string): T {
  return (bodyText ? JSON.parse(bodyText) : undefined) as T;
}

/**
 * Short, stable identifier for a token that's safe to log. Lets us correlate
 * "the token we stored at connect time" with "the token GitHub later 401'd"
 * across restarts — and cross-check against GitHub's authorized-apps page —
 * without ever logging the credential itself.
 */
function tokenFingerprint(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex').slice(0, 8);
}

/** Human-readable token age for log lines ("5h", "12d"). */
function describeTokenAge(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  const hours = Math.round(ms / 3_600_000);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** One resource bucket from `GET /rate_limit`. `reset` is a unix epoch (s). */
export interface GitHubRateLimitResource {
  limit: number;
  remaining: number;
  used: number;
  reset: number;
}

/** Parsed `GET /rate_limit` payload, keyed by resource name (core, graphql, …). */
export interface GitHubRateLimit {
  resources: Record<string, GitHubRateLimitResource>;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  // Users with a pending review request. Present on the list endpoint;
  // a reviewer drops off once they submit a review.
  requested_reviewers?: Array<{ login: string }>;
  // Present on the single-PR endpoint; the list endpoint omits these.
  merged?: boolean;
  merged_at?: string | null;
}

interface GitHubCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
  html_url: string;
}

interface GitHubReview {
  id: number;
  user: { login: string; avatar_url: string };
  body: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at: string;
  html_url: string;
}

interface GitHubReviewComment {
  id: number;
  user: { login: string; avatar_url: string };
  body: string;
  path: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request_review_id: number;
}

interface GitHubIssueComment {
  id: number;
  user: { login: string; avatar_url: string };
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GitHubNotification {
  type: 'review' | 'review_comment' | 'comment' | 'ci_failure' | 'mergeable';
  pr: GitHubPullRequest;
  repo: { owner: string; name: string };
  data: GitHubReview | GitHubReviewComment | GitHubIssueComment | GitHubCheckRun | { mergeable: boolean };
}

/**
 * A raw notification thread from `GET /notifications` — GitHub's user
 * activity feed. Used as a low-latency *trigger* (refetch this PR now), not
 * as a data source; the `subject.url` is an API URL we parse the PR number
 * from. `reason` ∈ review_requested | comment | ci_activity | state_change | …
 */
export interface GitHubNotificationThread {
  id: string;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string };
}

interface StoredToken {
  workspaceId: string;
  accessToken: string;
  tokenType: string;
  scope: string;
  createdAt: string;
}

/** Result of GitHub's app-authenticated `POST /applications/{client_id}/token` check. */
export interface TokenHealthCheck {
  workspaceId: string;
  fingerprint: string;
  /** When FastOwl stored the token (ISO). */
  storedCreatedAt: string;
  valid: boolean;
  /** Fields below only present when `valid`. */
  login?: string | null;
  githubCreatedAt?: string | null;
  /** Non-null means GitHub has a scheduled expiry for this token. */
  expiresAt?: string | null;
  scopes?: string[] | null;
}

/**
 * Persisted shape. `accessToken` used to be a plaintext string; new
 * rows write an `EncryptedEnvelope` under `accessTokenEnc` instead and
 * leave `accessToken` unset. Legacy rows are migrated to the encrypted
 * shape transparently on next write.
 */
interface GitHubIntegrationConfig {
  accessToken?: string;
  accessTokenEnc?: EncryptedEnvelope;
  tokenType?: string;
  scope?: string;
  createdAt?: string;
}

function readAccessToken(config: GitHubIntegrationConfig): string | null {
  if (config.accessTokenEnc && isEncryptedEnvelope(config.accessTokenEnc)) {
    try {
      return decryptString(config.accessTokenEnc);
    } catch (err) {
      console.error('Failed to decrypt GitHub access token:', err);
      return null;
    }
  }
  if (typeof config.accessToken === 'string' && config.accessToken.length > 0) {
    return config.accessToken;
  }
  return null;
}

class GitHubService extends EventEmitter {
  private tokens: Map<string, StoredToken> = new Map();
  // Authenticated user's login per workspace. Resolved once via /user
  // and reused — callers (e.g. the rate-limit poller) read it hot, so
  // we can't afford an API round-trip each time.
  private viewerLoginCache: Map<string, string> = new Map();
  // Authenticated user's team slugs (`org/team`) per workspace, with a fetch
  // timestamp. Teams change rarely, so we cache for an hour to avoid a
  // /user/teams round-trip on every poll's review-request derivation.
  private viewerTeamsCache: Map<string, { slugs: Set<string>; at: number }> = new Map();
  // Per-account promise chain that serializes Search API calls. GitHub asks
  // for serial (non-concurrent) requests per user and is most aggressive about
  // secondary limits on the tight `search` budget — so even across repos and
  // same-account workspaces, searches run one-at-a-time. Keyed by account.
  private searchChains: Map<string, Promise<unknown>> = new Map();

  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    await this.loadStoredTokens();
  }

  private async loadStoredTokens(): Promise<void> {
    try {
      const rows = await this.db
        .select({ workspaceId: integrationsTable.workspaceId, config: integrationsTable.config })
        .from(integrationsTable)
        .where(eq(integrationsTable.type, 'github'));

      let failed = 0;
      for (const row of rows) {
        const config = row.config as GitHubIntegrationConfig | null;
        const accessToken = config ? readAccessToken(config) : null;
        if (!config || !accessToken) {
          // A row exists but yields no usable token — almost always a decrypt
          // failure (FASTOWL_TOKEN_KEY differs from when it was saved). This is
          // the silent killer: 0 loaded tokens → every GitHub poller no-ops with
          // no HTTP, so the Debug panel goes quiet. Surface it loudly.
          failed++;
          continue;
        }
        this.tokens.set(row.workspaceId, {
          workspaceId: row.workspaceId,
          accessToken,
          tokenType: config.tokenType || 'bearer',
          scope: config.scope || '',
          createdAt: config.createdAt || new Date().toISOString(),
        });
      }

      const fingerprints = [...this.tokens.entries()]
        .map(([ws, t]) => `${ws}=fp:${tokenFingerprint(t.accessToken)}(${describeTokenAge(t.createdAt)})`)
        .join(' ');
      const summary =
        `Loaded ${this.tokens.size} GitHub token(s) from ${rows.length} integration row(s)` +
        ` (oauth app ${GITHUB_CLIENT_ID || 'unconfigured'})` +
        (fingerprints ? ` ${fingerprints}` : '') +
        (failed
          ? ` — ${failed} could not be read (likely a FASTOWL_TOKEN_KEY mismatch; reconnect GitHub to re-save).`
          : '');
      console.log(summary);
      debugBus.recordEvent({
        service: 'github',
        action: 'tokens:loaded',
        summary,
        ok: failed === 0,
        meta: { loaded: this.tokens.size, failed, rows: rows.length },
      });
      void this.registerWorkspaceOwners([...this.tokens.keys()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to load GitHub tokens:', err);
      debugBus.recordEvent({
        service: 'github',
        action: 'tokens:load-failed',
        summary: `Failed to load GitHub tokens: ${message}`,
        ok: false,
      });
    }
  }

  isConfigured(): boolean {
    return Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
  }

  getAuthorizationUrl(workspaceId: string, state: string): string {
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: GITHUB_REDIRECT_URI,
      scope: GITHUB_SCOPES.join(' '),
      state: `${workspaceId}:${state}`,
      allow_signup: 'false',
    });
    return `${GITHUB_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<{
    access_token: string;
    token_type: string;
    scope: string;
  }> {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_REDIRECT_URI,
      }),
    });

    debugBus.recordHttp({
      service: 'github',
      method: 'POST',
      url: GITHUB_TOKEN_URL,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ok: response.ok,
      ...(response.ok ? {} : { error: `token exchange: ${response.statusText}` }),
    });

    if (!response.ok) {
      throw new Error(`GitHub token exchange failed: ${response.statusText}`);
    }

    const data = parseJsonBody<{
      access_token: string;
      token_type: string;
      scope: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_token_expires_in?: number;
      error?: string;
      error_description?: string;
    }>(response.bodyText);
    if (data.error) {
      throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
    }
    // Forensics for the disappearing-token investigation: if GitHub ever
    // starts returning expiry fields here, the OAuth app has token
    // expiration enabled and every stored token has a scheduled death we
    // currently ignore (no refresh handling). Make that impossible to miss.
    if (data.expires_in !== undefined || data.refresh_token !== undefined) {
      const summary =
        `[github] token exchange returned EXPIRING token: expires_in=${data.expires_in}s` +
        ` refresh_token=${data.refresh_token ? 'present' : 'absent'}` +
        ` refresh_token_expires_in=${data.refresh_token_expires_in ?? 'n/a'} — ` +
        `FastOwl has no refresh handling; this token will die on schedule`;
      console.warn(summary);
      debugBus.recordEvent({
        service: 'github',
        action: 'token:expiring-grant',
        summary,
        ok: false,
        meta: {
          expiresIn: data.expires_in ?? null,
          hasRefreshToken: Boolean(data.refresh_token),
        },
      });
    }
    return data;
  }

  async storeToken(
    workspaceId: string,
    accessToken: string,
    tokenType: string,
    scope: string
  ): Promise<void> {
    const createdAt = new Date().toISOString();
    // New rows: encrypt the access token; drop the plaintext field.
    // Existing plaintext rows will be overwritten with the encrypted
    // shape on next storeToken call (disconnect+reconnect, or token
    // rotation).
    const config: GitHubIntegrationConfig = {
      accessTokenEnc: encryptString(accessToken),
      tokenType,
      scope,
      createdAt,
    };

    const existing = await this.db
      .select({ id: integrationsTable.id })
      .from(integrationsTable)
      .where(
        and(eq(integrationsTable.workspaceId, workspaceId), eq(integrationsTable.type, 'github'))
      )
      .limit(1);

    const now = new Date();
    if (existing[0]) {
      await this.db
        .update(integrationsTable)
        .set({ config, updatedAt: now })
        .where(eq(integrationsTable.id, existing[0].id));
    } else {
      await this.db.insert(integrationsTable).values({
        id: uuid(),
        workspaceId,
        type: 'github',
        config,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Log enough to reconstruct the token's life later: which OAuth app
    // minted it, its fingerprint, and what (if anything) it replaced. When a
    // token later dies with a 401 this is how we tell "rotated by a reconnect
    // elsewhere" apart from "revoked by GitHub out of the blue".
    const prior = this.tokens.get(workspaceId);
    const fp = tokenFingerprint(accessToken);
    const summary =
      `[github] workspace ${workspaceId}: stored token fp:${fp} scopes="${scope}" ` +
      `(oauth app ${GITHUB_CLIENT_ID || 'unconfigured'})` +
      (prior
        ? ` — replaces fp:${tokenFingerprint(prior.accessToken)} (age ${describeTokenAge(prior.createdAt)})`
        : '');
    console.log(summary);
    debugBus.recordEvent({
      service: 'github',
      action: 'token:stored',
      summary,
      ok: true,
      meta: {
        workspaceId,
        fingerprint: fp,
        scope,
        replacedFingerprint: prior ? tokenFingerprint(prior.accessToken) : null,
      },
    });

    this.tokens.set(workspaceId, {
      workspaceId,
      accessToken,
      tokenType,
      scope,
      createdAt,
    });
    void this.registerWorkspaceOwners([workspaceId]);
    this.emit('connected', workspaceId);
  }

  /**
   * Tell the debug bus which FastOwl account owns each workspace, so the admin
   * Debug panel can attribute and filter activity by user. Best-effort — a
   * failed lookup just leaves that workspace's events unattributed ("system").
   */
  private async registerWorkspaceOwners(workspaceIds: string[]): Promise<void> {
    if (workspaceIds.length === 0) return;
    try {
      const rows = await this.db
        .select({
          workspaceId: workspacesTable.id,
          ownerId: workspacesTable.ownerId,
          email: usersTable.email,
          githubUsername: usersTable.githubUsername,
        })
        .from(workspacesTable)
        .innerJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
        .where(inArray(workspacesTable.id, workspaceIds));
      for (const r of rows) {
        const label = r.githubUsername ? `@${r.githubUsername}` : r.email;
        debugBus.registerOwner(r.workspaceId, r.ownerId, label);
      }
    } catch (err) {
      console.error('Failed to register workspace owners for debug attribution:', err);
    }
  }

  /**
   * Delete the workspace's GitHub integration. `reason` is mandatory in
   * spirit: this runs both for explicit user disconnects AND automatically
   * when GitHub 401s a request, and prod has seen surprise disconnects —
   * the log line here is how we tell those apart after the fact.
   */
  async removeToken(workspaceId: string, reason = 'unspecified'): Promise<void> {
    const prior = this.tokens.get(workspaceId);
    const summary =
      `[github] workspace ${workspaceId}: REMOVING token` +
      (prior
        ? ` fp:${tokenFingerprint(prior.accessToken)} (age ${describeTokenAge(prior.createdAt)})`
        : ' (none cached)') +
      ` — reason: ${reason}`;
    console.warn(summary);
    debugBus.recordEvent({
      service: 'github',
      action: 'token:removed',
      summary,
      ok: false,
      meta: {
        workspaceId,
        reason,
        fingerprint: prior ? tokenFingerprint(prior.accessToken) : null,
        tokenAge: prior ? describeTokenAge(prior.createdAt) : null,
      },
    });

    await this.db
      .delete(integrationsTable)
      .where(
        and(eq(integrationsTable.workspaceId, workspaceId), eq(integrationsTable.type, 'github'))
      );
    this.tokens.delete(workspaceId);
    this.viewerLoginCache.delete(workspaceId);
    this.viewerTeamsCache.delete(workspaceId);
    this.emit('disconnected', workspaceId);
  }

  isConnected(workspaceId: string): boolean {
    return this.tokens.has(workspaceId);
  }

  getConnectionStatus(workspaceId: string): {
    connected: boolean;
    user?: GitHubUser;
    scopes?: string[];
  } {
    const token = this.tokens.get(workspaceId);
    if (!token) return { connected: false };
    return { connected: true, scopes: token.scope.split(' ').filter(Boolean) };
  }

  /**
   * The key under which this workspace's GitHub *account* is tracked for
   * rate-limiting. GitHub budgets (primary and secondary) are per account, but
   * our state is keyed by workspace — and multiple workspaces can share one
   * OAuth token. Prefer the cached login (what the rate-limit poller keys on),
   * fall back to the raw token, then the workspace id. Synchronous, so it's
   * safe in the hot request path.
   */
  accountKeyFor(workspaceId: string): string {
    return (
      this.viewerLoginCache.get(workspaceId) ??
      this.tokens.get(workspaceId)?.accessToken ??
      workspaceId
    );
  }

  /**
   * Run `fn` after any in-flight work already queued for `accountKey`, so calls
   * for one account never overlap. Used to serialize Search API requests.
   */
  private serializeByAccount<T>(accountKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.searchChains.get(accountKey) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Store a settled marker so the chain links without retaining results or
    // rejecting the next link on a prior failure.
    this.searchChains.set(
      accountKey,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async apiRequest<T>(
    workspaceId: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.tokens.get(workspaceId);
    if (!token) {
      throw new Error('GitHub not connected for this workspace');
    }

    const accountKey = this.accountKeyFor(workspaceId);
    // Pause behind any active secondary-rate-limit backoff for this account
    // before adding to the load. Throws if the wait would be too long.
    await githubRateGate.waitIfBlocked(accountKey);

    const method = (options.method ?? 'GET').toUpperCase();
    const url = `${GITHUB_API_URL}${endpoint}`;
    const startedAt = Date.now();

    let response: TimedResponse;
    try {
      response = await fetchWithTimeout(url, {
        ...options,
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `${token.tokenType} ${token.accessToken}`,
          'User-Agent': 'FastOwl',
          ...options.headers,
        },
      });
    } catch (err) {
      debugBus.recordHttp({
        service: 'github',
        method,
        url,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        workspaceId,
      });
      throw err;
    }

    if (!response.ok) {
      const bodyText = response.bodyText;
      const rl = parseRateLimitResponse(response, bodyText);
      if (rl.isRateLimited) {
        githubRateGate.block(
          accountKey,
          Date.now() + rl.retryAfterMs,
          `${method} ${redactUrl(url)}`,
        );
      }
      const error =
        response.status === 401
          ? 'GitHub token expired or revoked'
          : this.describeApiErrorFromText(response.status, response.statusText, bodyText);
      debugBus.recordHttp({
        service: 'github',
        method,
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        ok: false,
        error,
        workspaceId,
      });
      if (response.status === 401) {
        // GitHub's body says WHY ("Bad credentials" = revoked/invalid vs
        // "...token expired") and the request id lets GitHub support trace it.
        await this.removeToken(
          workspaceId,
          `401 on ${method} ${redactUrl(url)} — body: ${bodyText.slice(0, 200) || '(empty)'}, ` +
            `request-id: ${response.headers.get('x-github-request-id') ?? 'n/a'}`
        );
      }
      if (rl.isRateLimited) {
        throw new GitHubRateLimitError(error, rl.retryAfterMs);
      }
      throw new Error(error);
    }

    debugBus.recordHttp({
      service: 'github',
      method,
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ok: true,
      workspaceId,
    });
    return parseJsonBody<T>(response.bodyText);
  }

  /**
   * The authenticated user's current rate-limit budgets across every resource
   * bucket (`core`, `graphql`, `search`, …). Hitting `/rate_limit` itself does
   * NOT count against any budget, so it's the authoritative way to read the
   * live state without depending on incidental traffic. Drives the Debug
   * panel's rate-limit cards via {@link rateLimitPoller}.
   */
  async getRateLimit(workspaceId: string): Promise<GitHubRateLimit> {
    return this.apiRequest<GitHubRateLimit>(workspaceId, '/rate_limit');
  }

  /**
   * Turn a failed GitHub response into a useful message. GitHub returns
   * a JSON body — `{ message, documentation_url, errors }` — that almost
   * always explains *why* (e.g. a 403 on merge: "At least 1 approving
   * review is required" or "Resource not accessible by personal access
   * token"). We previously threw only `statusText` ("Forbidden"), which
   * told the user nothing. Surface the body's message, falling back to
   * the status line if it isn't JSON.
   */
  private describeApiErrorFromText(status: number, statusText: string, bodyText: string): string {
    let detail = '';
    try {
      const body = JSON.parse(bodyText) as {
        message?: string;
        errors?: Array<{ message?: string; code?: string; field?: string }>;
      };
      detail = body.message ?? '';
      const sub = (body.errors ?? [])
        .map((e) => e.message ?? [e.field, e.code].filter(Boolean).join(' '))
        .filter(Boolean)
        .join('; ');
      if (sub) detail = detail ? `${detail} (${sub})` : sub;
    } catch {
      // Non-JSON / empty body — fall back to the status line below.
    }
    const base = `GitHub API error ${status} ${statusText}`.trim();
    return detail ? `${base}: ${detail}` : base;
  }

  async getUser(workspaceId: string): Promise<GitHubUser> {
    return this.apiRequest<GitHubUser>(workspaceId, '/user');
  }

  /**
   * The authenticated user's team slugs as `org/team` (combinedSlug form),
   * across every org. Cached for an hour — teams change rarely and the poll's
   * review-request derivation asks for them constantly. Returns an empty set
   * on failure so derivation degrades to "no team requests" rather than
   * throwing the whole poll.
   */
  async getViewerTeamSlugs(workspaceId: string): Promise<Set<string>> {
    const cached = this.viewerTeamsCache.get(workspaceId);
    if (cached && Date.now() - cached.at < 60 * 60_000) return cached.slugs;
    try {
      const teams = await this.apiRequest<
        Array<{ slug: string; organization: { login: string } }>
      >(workspaceId, '/user/teams?per_page=100');
      const slugs = new Set(
        teams
          .filter((t) => t.organization?.login && t.slug)
          .map((t) => `${t.organization.login}/${t.slug}`.toLowerCase())
      );
      this.viewerTeamsCache.set(workspaceId, { slugs, at: Date.now() });
      return slugs;
    } catch {
      // Don't cache a failure — retry next time, meanwhile degrade gracefully.
      return cached?.slugs ?? new Set();
    }
  }

  /**
   * The authenticated user's notification threads — GitHub's user-scoped
   * activity feed. Designed for polling: pass the previous response's
   * `Last-Modified` as `ifModifiedSince` to get a free `304` when nothing
   * changed, and respect the returned `pollInterval` (X-Poll-Interval). We
   * fetch `all=true` so reading notifications in the GitHub UI doesn't blank
   * the feed, and bound the payload with `since`.
   */
  async listNotifications(
    workspaceId: string,
    opts: { since?: string; ifModifiedSince?: string } = {}
  ): Promise<{
    status: number;
    notifications: GitHubNotificationThread[];
    lastModified: string | null;
    pollInterval: number | null;
  }> {
    const token = this.tokens.get(workspaceId);
    if (!token) throw new Error('GitHub not connected for this workspace');

    const url = new URL(`${GITHUB_API_URL}/notifications`);
    url.searchParams.set('all', 'true');
    if (opts.since) url.searchParams.set('since', opts.since);

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `${token.tokenType} ${token.accessToken}`,
      'User-Agent': 'FastOwl',
    };
    if (opts.ifModifiedSince) headers['If-Modified-Since'] = opts.ifModifiedSince;

    const response = await fetchWithTimeout(url.toString(), { headers });
    const lastModified = response.headers.get('last-modified');
    const pollHeader = response.headers.get('x-poll-interval');
    const pollInterval = pollHeader ? Number.parseInt(pollHeader, 10) : null;

    if (response.status === 304) {
      return { status: 304, notifications: [], lastModified, pollInterval };
    }
    if (response.status === 401) {
      await this.removeToken(
        workspaceId,
        `401 on GET /notifications — body: ${response.bodyText.slice(0, 200) || '(empty)'}, ` +
          `request-id: ${response.headers.get('x-github-request-id') ?? 'n/a'}`
      );
      throw new Error('GitHub token expired or revoked');
    }
    if (!response.ok) {
      throw new Error(
        this.describeApiErrorFromText(response.status, response.statusText, response.bodyText)
      );
    }

    const notifications = parseJsonBody<GitHubNotificationThread[]>(response.bodyText);
    return { status: response.status, notifications, lastModified, pollInterval };
  }

  /**
   * The connected user's login for a workspace, cached. Returns null
   * when GitHub isn't connected or the lookup fails — callers treat a
   * null login as "can't tell, don't filter on identity".
   */
  async getViewerLogin(workspaceId: string): Promise<string | null> {
    const cached = this.viewerLoginCache.get(workspaceId);
    if (cached) return cached;
    if (!this.tokens.has(workspaceId)) return null;
    try {
      const user = await this.getUser(workspaceId);
      this.viewerLoginCache.set(workspaceId, user.login);
      return user.login;
    } catch {
      return null;
    }
  }

  /**
   * Every repo the user can access (owner + collaborator + org member),
   * across all pages. GitHub caps `per_page` at 100, so we walk pages
   * until a short page signals the end. A hard page cap guards against
   * runaway loops on pathological accounts.
   */
  async listRepositories(workspaceId: string): Promise<GitHubRepo[]> {
    return this.paginate<GitHubRepo>(
      workspaceId,
      (page) =>
        `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`
    );
  }

  /**
   * Orgs the user belongs to. Unions two endpoints because neither is
   * complete on its own:
   *   - `/user/orgs` (authenticated): includes private memberships, but
   *     is GATED by the org's OAuth-app approval — an org that restricts
   *     third-party apps and hasn't approved us is omitted.
   *   - `/users/{login}/orgs` (public): returns public memberships
   *     regardless of app approval, so it catches restricted orgs (e.g.
   *     PostHog) that `/user/orgs` drops.
   * Each is best-effort; we merge + dedupe by login.
   */
  async listOrganizations(
    workspaceId: string
  ): Promise<Array<{ login: string; avatar_url: string }>> {
    const byLogin = new Map<string, { login: string; avatar_url: string }>();
    try {
      const authed = await this.paginate<{ login: string; avatar_url: string }>(
        workspaceId,
        (page) => `/user/orgs?per_page=100&page=${page}`
      );
      for (const o of authed) byLogin.set(o.login, o);
    } catch (err) {
      console.warn('[github] /user/orgs failed:', err);
    }
    try {
      const user = await this.getUser(workspaceId);
      const publicOrgs = await this.paginate<{ login: string; avatar_url: string }>(
        workspaceId,
        (page) =>
          `/users/${encodeURIComponent(user.login)}/orgs?per_page=100&page=${page}`
      );
      for (const o of publicOrgs) byLogin.set(o.login, o);
    } catch (err) {
      console.warn('[github] /users/:login/orgs failed:', err);
    }
    return Array.from(byLogin.values());
  }

  /**
   * Repos in a specific org. `type=all` returns private repos too when
   * the token has access (org approved the app); public org repos always
   * come back regardless of OAuth-app approval, since public data is
   * exempt from third-party-app restrictions.
   */
  async listOrgRepositories(workspaceId: string, org: string): Promise<GitHubRepo[]> {
    return this.paginate<GitHubRepo>(
      workspaceId,
      (page) =>
        `/orgs/${encodeURIComponent(org)}/repos?per_page=100&page=${page}&type=all&sort=pushed`
    );
  }

  /**
   * Every repo the user can reach: their own/collaborator/org-member
   * repos, plus the repos of every org they belong to (which surfaces
   * org repos that don't appear in `/user/repos`). Merged + deduped by
   * full_name. Each source is best-effort — one org failing (e.g. a
   * permissions blip) doesn't sink the whole list. This is the
   * expensive call the desktop caches client-side behind a refresh.
   */
  async listAllAccessibleRepos(workspaceId: string): Promise<GitHubRepo[]> {
    const byFullName = new Map<string, GitHubRepo>();
    try {
      for (const r of await this.listRepositories(workspaceId)) {
        byFullName.set(r.full_name, r);
      }
    } catch (err) {
      console.warn('[github] listRepositories failed:', err);
    }
    let orgs: string[] = [];
    try {
      orgs = (await this.listOrganizations(workspaceId)).map((o) => o.login);
    } catch (err) {
      console.warn('[github] listOrganizations failed:', err);
    }
    for (const org of orgs) {
      try {
        for (const r of await this.listOrgRepositories(workspaceId, org)) {
          byFullName.set(r.full_name, r);
        }
      } catch (err) {
        console.warn(`[github] org repos failed for ${org}:`, err);
      }
    }
    return Array.from(byFullName.values());
  }

  /** Walk a paginated GitHub list endpoint until a non-full page. */
  private async paginate<T>(
    workspaceId: string,
    urlForPage: (page: number) => string,
    maxPages = 20
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.apiRequest<T[]>(workspaceId, urlForPage(page));
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  async getRepository(workspaceId: string, owner: string, repo: string): Promise<GitHubRepo> {
    return this.apiRequest<GitHubRepo>(workspaceId, `/repos/${owner}/${repo}`);
  }

  async listPullRequests(
    workspaceId: string,
    owner: string,
    repo: string,
    options: { state?: 'open' | 'closed' | 'all'; per_page?: number } = {}
  ): Promise<GitHubPullRequest[]> {
    const params = new URLSearchParams({
      state: options.state || 'open',
      per_page: String(options.per_page || 30),
    });
    return this.apiRequest<GitHubPullRequest[]>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls?${params}`
    );
  }

  async getPullRequest(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number
  ): Promise<GitHubPullRequest> {
    return this.apiRequest<GitHubPullRequest>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls/${number}`
    );
  }

  /**
   * Find PR numbers via the search API. Used instead of listing a repo's
   * open PRs and filtering client-side: in a huge repo (hundreds of open
   * PRs) the user's own PRs fall outside the first page, so listing
   * silently drops them. Search returns exactly the matches regardless of
   * repo size. Paginated (search caps at 1000 results / 10 pages of 100).
   */
  async searchPullRequestNumbers(workspaceId: string, query: string): Promise<number[]> {
    // Serialize per account: the `search` budget is tiny (30/min) and the most
    // secondary-limit-prone, so searches for one account never run concurrently.
    return this.serializeByAccount(this.accountKeyFor(workspaceId), async () => {
      const out: number[] = [];
      for (let page = 1; page <= 10; page++) {
        const params = new URLSearchParams({
          q: query,
          per_page: '100',
          page: String(page),
        });
        const res = await this.apiRequest<{
          total_count: number;
          items: Array<{ number: number }>;
        }>(workspaceId, `/search/issues?${params}`);
        out.push(...res.items.map((i) => i.number));
        if (res.items.length < 100) break;
      }
      return out;
    });
  }

  async getCheckRuns(
    workspaceId: string,
    owner: string,
    repo: string,
    ref: string
  ): Promise<{ total_count: number; check_runs: GitHubCheckRun[] }> {
    return this.apiRequest(workspaceId, `/repos/${owner}/${repo}/commits/${ref}/check-runs`);
  }

  async createPRComment(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    body: string
  ): Promise<{ id: number; html_url: string }> {
    return this.apiRequest(workspaceId, `/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  async getPRReviews(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number
  ): Promise<GitHubReview[]> {
    return this.apiRequest<GitHubReview[]>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls/${number}/reviews`
    );
  }

  async getPRReviewComments(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    options: { since?: string } = {}
  ): Promise<GitHubReviewComment[]> {
    const params = new URLSearchParams();
    if (options.since) params.set('since', options.since);
    const query = params.toString();
    return this.apiRequest<GitHubReviewComment[]>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls/${number}/comments${query ? `?${query}` : ''}`
    );
  }

  async getPRComments(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    options: { since?: string } = {}
  ): Promise<GitHubIssueComment[]> {
    const params = new URLSearchParams();
    if (options.since) params.set('since', options.since);
    const query = params.toString();
    return this.apiRequest<GitHubIssueComment[]>(
      workspaceId,
      `/repos/${owner}/${repo}/issues/${number}/comments${query ? `?${query}` : ''}`
    );
  }

  getConnectedWorkspaces(): string[] {
    return Array.from(this.tokens.keys());
  }

  /**
   * Ask GitHub (app-authenticated, free — no user budget spent) whether a
   * workspace's stored token is still valid, and what GitHub knows about it:
   * owning login, creation time, and any scheduled `expires_at`. This is the
   * forensic ground truth for the disappearing-token investigation — a 404
   * here means GitHub revoked the token server-side, independent of any
   * poll-loop detection lag.
   */
  async checkTokenHealth(workspaceId: string): Promise<TokenHealthCheck | null> {
    const stored = this.tokens.get(workspaceId);
    if (!stored || !GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) return null;
    const fingerprint = tokenFingerprint(stored.accessToken);
    const url = `${GITHUB_API_URL}/applications/${GITHUB_CLIENT_ID}/token`;
    const startedAt = Date.now();
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${GITHUB_CLIENT_ID}:${GITHUB_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: JSON.stringify({ access_token: stored.accessToken }),
    });
    debugBus.recordHttp({
      service: 'github',
      method: 'POST',
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ok: response.ok || response.status === 404,
      ...(response.ok || response.status === 404
        ? {}
        : { error: `check-token: ${response.statusText}` }),
    });
    if (response.status === 404) {
      // Token is dead on GitHub's side. Don't remove it here — leave that to
      // the regular 401 path so this stays a pure observer.
      return { workspaceId, fingerprint, storedCreatedAt: stored.createdAt, valid: false };
    }
    if (!response.ok) {
      throw new Error(`GitHub check-token failed: ${response.status} ${response.statusText}`);
    }
    const auth = parseJsonBody<{
      created_at?: string;
      expires_at?: string | null;
      scopes?: string[] | null;
      user?: { login?: string } | null;
    }>(response.bodyText);
    return {
      workspaceId,
      fingerprint,
      storedCreatedAt: stored.createdAt,
      valid: true,
      login: auth.user?.login ?? null,
      githubCreatedAt: auth.created_at ?? null,
      expiresAt: auth.expires_at ?? null,
      scopes: auth.scopes ?? null,
    };
  }

  async mergePullRequest(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    options: {
      commit_title?: string;
      commit_message?: string;
      merge_method?: 'merge' | 'squash' | 'rebase';
    } = {}
  ): Promise<{ sha: string; merged: boolean; message: string }> {
    return this.apiRequest(
      workspaceId,
      `/repos/${owner}/${repo}/pulls/${number}/merge`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commit_title: options.commit_title,
          commit_message: options.commit_message,
          merge_method: options.merge_method || 'merge',
        }),
      }
    );
  }

  async createPullRequest(
    workspaceId: string,
    owner: string,
    repo: string,
    options: {
      title: string;
      head: string;
      base: string;
      body?: string;
      draft?: boolean;
    }
  ): Promise<GitHubPullRequest> {
    return this.apiRequest<GitHubPullRequest>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      }
    );
  }

  async createPRReview(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    options: {
      body?: string;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      comments?: Array<{ path: string; position?: number; body: string }>;
    }
  ): Promise<GitHubReview> {
    return this.apiRequest<GitHubReview>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls/${number}/reviews`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      }
    );
  }

  async updatePullRequest(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    options: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string }
  ): Promise<GitHubPullRequest> {
    return this.apiRequest<GitHubPullRequest>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls/${number}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      }
    );
  }

  async listBranches(
    workspaceId: string,
    owner: string,
    repo: string,
    options: { per_page?: number; page?: number } = {}
  ): Promise<Array<{ name: string; protected: boolean }>> {
    const params = new URLSearchParams({
      per_page: String(options.per_page || 100),
      page: String(options.page || 1),
    });
    return this.apiRequest(workspaceId, `/repos/${owner}/${repo}/branches?${params}`);
  }

  async getPRFiles(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number
  ): Promise<Array<{
    sha: string;
    filename: string;
    status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
  }>> {
    return this.apiRequest(workspaceId, `/repos/${owner}/${repo}/pulls/${number}/files`);
  }

  /**
   * Fire a GraphQL query against the v4 endpoint with the workspace's
   * stored OAuth token. Used by the batched PR + checks fetcher in
   * `services/githubGraphql.ts` — one query pulls a PR's reviews,
   * statusCheckRollup, mergeable, and reviewDecision in one round-trip
   * where REST would need 4–6.
   *
   * Throws if the workspace has no token (caller should surface
   * "connect GitHub" UX). 401 → token revoked, dropped from the cache
   * and a clear error thrown.
   */
  async executeGraphql<T>(
    workspaceId: string,
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    const token = this.tokens.get(workspaceId);
    if (!token) {
      throw new Error('GitHub not connected for this workspace');
    }
    // GitHub's GraphQL endpoint occasionally 502/503/504s on heavy
    // queries (the statusCheckRollup is expensive to resolve). These are
    // transient — retry a couple of times with backoff before giving up.
    const maxAttempts = 3;
    const gqlUrl = `${GITHUB_API_URL}/graphql`;
    const accountKey = this.accountKeyFor(workspaceId);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Pause behind any active secondary-rate-limit backoff before sending.
      await githubRateGate.waitIfBlocked(accountKey);
      const startedAt = Date.now();
      let response: TimedResponse;
      try {
        response = await fetchWithTimeout(gqlUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `${token.tokenType} ${token.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'FastOwl',
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        // Network failure or timeout — no `response` to read a status off.
        // Record it, then retry with backoff (same as a transient 5xx) so a
        // single stalled socket doesn't abort the whole query.
        const msg = err instanceof Error ? err.message : String(err);
        debugBus.recordHttp({
          service: 'github',
          method: 'POST',
          url: gqlUrl,
          durationMs: Date.now() - startedAt,
          ok: false,
          workspaceId,
          error: msg,
        });
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw err;
      }
      const recordGql = (ok: boolean, error?: string) =>
        debugBus.recordHttp({
          service: 'github',
          method: 'POST',
          url: gqlUrl,
          status: response.status,
          durationMs: Date.now() - startedAt,
          ok,
          workspaceId,
          ...(error ? { error } : {}),
        });
      if (response.ok) {
        const payload = parseJsonBody<{
          data?: T;
          errors?: Array<{ message: string }>;
        }>(response.bodyText);
        if (payload.errors && payload.errors.length > 0) {
          // Surface the first GraphQL error verbatim — callers want to see
          // "Resource not accessible" or "Could not resolve to a Repository"
          // rather than a generic 200-but-failed.
          recordGql(false, `GraphQL: ${payload.errors[0].message}`);
          throw new Error(`GitHub GraphQL: ${payload.errors[0].message}`);
        }
        if (!payload.data) {
          recordGql(false, 'response missing data');
          throw new Error('GitHub GraphQL response missing data');
        }
        recordGql(true);
        return payload.data;
      }
      if (response.status === 401) {
        recordGql(false, 'token expired or revoked');
        await this.removeToken(
          workspaceId,
          `401 on POST /graphql — body: ${response.bodyText.slice(0, 200) || '(empty)'}, ` +
            `request-id: ${response.headers.get('x-github-request-id') ?? 'n/a'}`
        );
        throw new Error('GitHub token expired or revoked');
      }
      // A secondary-rate-limit 403/429 is NOT retried inline — that would burst
      // against the very limit we tripped. Record the backoff and bail; the next
      // gated tick retries once the window clears.
      const rl = parseRateLimitResponse(response, response.bodyText);
      if (rl.isRateLimited) {
        githubRateGate.block(accountKey, Date.now() + rl.retryAfterMs, 'graphql');
        recordGql(false, 'secondary rate limit');
        throw new GitHubRateLimitError('GitHub GraphQL rate-limited', rl.retryAfterMs);
      }
      const retryable = response.status === 502 || response.status === 503 || response.status === 504;
      recordGql(false, response.statusText);
      if (retryable && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw new Error(`GitHub GraphQL error: ${response.statusText}`);
    }
    // Unreachable — the loop either returns or throws.
    throw new Error('GitHub GraphQL: exhausted retries');
  }
}

export const githubService = new GitHubService();
