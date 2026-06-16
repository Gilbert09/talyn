import { EventEmitter } from 'events';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { and, eq, inArray } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import {
  integrations as integrationsTable,
  workspaces as workspacesTable,
  users as usersTable,
  githubInstallations as githubInstallationsTable,
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
import {
  getInstallationToken,
  clearInstallationToken,
  isGitHubAppConfigured,
  InstallationUnavailableError,
  refreshUserToken,
  UserTokenRefreshError,
} from './githubApp.js';

// Classic-OAuth-app credentials. Still read for the check-token (token-health)
// forensic path; the connect flow itself is now the GitHub App (see githubApp.ts).
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';

const GITHUB_API_URL = 'https://api.github.com';

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

/**
 * The token's type prefix (`gho_` = OAuth app, `ghu_` = GitHub App
 * user-to-server, etc.). Not secret — it's pure type information — and it
 * settles which token family GitHub minted us (ghu_ would mean expiring
 * GitHub App tokens we have no refresh handling for).
 */
function tokenPrefix(accessToken: string): string {
  return /^gh[a-z]_/.exec(accessToken)?.[0] ?? 'unprefixed';
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

interface StoredToken {
  workspaceId: string;
  accessToken: string;
  tokenType: string;
  scope: string;
  createdAt: string;
  // Set for GitHub-App-connected workspaces (hybrid auth): the stored token
  // above is the user-to-server token (viewer identity); data-plane reads use a
  // freshly-minted installation token keyed by this id. Absent ⇒ legacy OAuth
  // workspace, every call uses the stored token (unchanged behaviour).
  installationId?: string;
  // Set when the App has "Expire user authorization tokens" enabled: the user
  // token lives ~8h and is rotated via `refreshToken` before expiry. Absent ⇒
  // a non-expiring token (classic OAuth, or App with expiry off) — never refreshed.
  refreshToken?: string;
  accessTokenExpiresAt?: number; // epoch ms
  refreshTokenExpiresAt?: number; // epoch ms
}

/** Resolved auth for one outbound call — which token family it used. */
interface ResolvedAuth {
  tokenType: string;
  accessToken: string;
  kind: 'installation' | 'user';
  installationId?: string;
}

/** Result of GitHub's app-authenticated `POST /applications/{client_id}/token` check. */
export interface TokenHealthCheck {
  workspaceId: string;
  fingerprint: string;
  /** Token type prefix (`gho_` OAuth app, `ghu_` GitHub App user token, …). */
  prefix: string;
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
  // GitHub App (hybrid auth): when set, `accessTokenEnc` is the user-to-server
  // token and `installationId` backs the data-plane installation token.
  authMethod?: 'github_app';
  installationId?: string;
  // Rotation state for an expiring user token (App with token expiry enabled).
  refreshTokenEnc?: EncryptedEnvelope;
  accessTokenExpiresAt?: string; // ISO
  refreshTokenExpiresAt?: string; // ISO
}

/**
 * Best-effort repo owner from a REST endpoint, so a data-plane call can pick the
 * installation covering that account. Handles `/repos/{owner}/…` and the
 * `repo:{owner}/{repo}` search qualifier; returns undefined for owner-less
 * endpoints (`/user`, `/rate_limit`, `/app/…`) — those use the user token or the
 * workspace's primary installation.
 */
function ownerFromEndpoint(endpoint: string): string | undefined {
  const repos = /\/repos\/([^/]+)\//.exec(endpoint);
  if (repos) return decodeURIComponent(repos[1]);
  const search = /[?&]q=[^&]*repo:([^/%]+)(?:\/|%2F)/i.exec(endpoint);
  if (search) return decodeURIComponent(search[1]);
  return undefined;
}

/** Decrypt an envelope, returning undefined (not throwing) on failure. */
function safeDecrypt(envelope: EncryptedEnvelope): string | undefined {
  try {
    return decryptString(envelope);
  } catch (err) {
    console.error('Failed to decrypt GitHub refresh token:', err);
    return undefined;
  }
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
  // GitHub App installations keyed by account login (lowercased) → installation
  // id. Installations are PER-ACCOUNT (a user can install the App on their
  // personal account + several orgs), so data-plane reads resolve the right
  // installation by the repo's owner — not by a single per-workspace id.
  // Loaded from `github_installations` at init + on connect/installation events.
  private installationsByAccount: Map<string, string> = new Map();
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
  // Coalesce concurrent user-token refreshes per workspace into one HTTP call.
  private userTokenRefreshes: Map<string, Promise<StoredToken | null>> = new Map();

  // Refresh an expiring user token once it's within this window of expiry.
  private static readonly USER_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    await this.loadStoredTokens();
    await this.refreshInstallationIndex();
  }

  /**
   * Rebuild the account-login → installation-id index from `github_installations`.
   * Called at init, after an install completes, and on `installation*` webhooks.
   * Suspended installations are excluded so we don't mint tokens for them.
   */
  async refreshInstallationIndex(): Promise<void> {
    try {
      const rows = await this.db
        .select({
          installationId: githubInstallationsTable.installationId,
          accountLogin: githubInstallationsTable.accountLogin,
          suspendedAt: githubInstallationsTable.suspendedAt,
        })
        .from(githubInstallationsTable);
      const next = new Map<string, string>();
      for (const r of rows) {
        if (r.suspendedAt) continue;
        if (r.accountLogin) next.set(r.accountLogin.toLowerCase(), r.installationId);
      }
      this.installationsByAccount = next;
    } catch (err) {
      console.error('Failed to load GitHub installation index:', err);
    }
  }

  /** The installation id covering a repo owner (account login), if the App is installed there. */
  private installationForOwner(owner: string | undefined): string | undefined {
    if (!owner) return undefined;
    return this.installationsByAccount.get(owner.toLowerCase());
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
        const refreshToken =
          config.refreshTokenEnc && isEncryptedEnvelope(config.refreshTokenEnc)
            ? safeDecrypt(config.refreshTokenEnc)
            : undefined;
        this.tokens.set(row.workspaceId, {
          workspaceId: row.workspaceId,
          accessToken,
          tokenType: config.tokenType || 'bearer',
          scope: config.scope || '',
          createdAt: config.createdAt || new Date().toISOString(),
          ...(config.installationId ? { installationId: config.installationId } : {}),
          ...(refreshToken ? { refreshToken } : {}),
          ...(config.accessTokenExpiresAt
            ? { accessTokenExpiresAt: new Date(config.accessTokenExpiresAt).getTime() }
            : {}),
          ...(config.refreshTokenExpiresAt
            ? { refreshTokenExpiresAt: new Date(config.refreshTokenExpiresAt).getTime() }
            : {}),
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

  /**
   * Whether GitHub connection is available. The connect flow is now the GitHub
   * App, so this is App config first; the classic-OAuth creds also count so a
   * deployment still mid-migration (App not yet set up) isn't reported broken.
   */
  isConfigured(): boolean {
    return isGitHubAppConfigured() || Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
  }

  /**
   * The decrypted GitHub access token for a workspace, or null if GitHub
   * isn't connected. This is the same in-memory token the service uses for
   * its own API calls (kept current on connect), so consumers like the
   * Claude Code provider can reuse the workspace's connection instead of
   * asking for a separate PAT.
   */
  getAccessToken(workspaceId: string): string | null {
    return this.tokens.get(workspaceId)?.accessToken ?? null;
  }

  async storeToken(
    workspaceId: string,
    accessToken: string,
    tokenType: string,
    scope: string,
    opts: {
      installationId?: string;
      refreshToken?: string;
      accessTokenExpiresAt?: number;
      refreshTokenExpiresAt?: number;
    } = {}
  ): Promise<void> {
    const createdAt = new Date().toISOString();
    // New rows: encrypt the access token; drop the plaintext field.
    // Existing plaintext rows will be overwritten with the encrypted
    // shape on next storeToken call (disconnect+reconnect, or token
    // rotation). For an App connection (hybrid auth) the encrypted token is
    // the user-to-server token and `installationId` backs the data plane.
    const config: GitHubIntegrationConfig = {
      accessTokenEnc: encryptString(accessToken),
      tokenType,
      scope,
      createdAt,
      ...(opts.installationId
        ? { authMethod: 'github_app' as const, installationId: opts.installationId }
        : {}),
      ...(opts.refreshToken ? { refreshTokenEnc: encryptString(opts.refreshToken) } : {}),
      ...(opts.accessTokenExpiresAt
        ? { accessTokenExpiresAt: new Date(opts.accessTokenExpiresAt).toISOString() }
        : {}),
      ...(opts.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: new Date(opts.refreshTokenExpiresAt).toISOString() }
        : {}),
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
      `[github] workspace ${workspaceId}: stored token fp:${fp} prefix=${tokenPrefix(accessToken)} scopes="${scope}" ` +
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
      ...(opts.installationId ? { installationId: opts.installationId } : {}),
      ...(opts.refreshToken ? { refreshToken: opts.refreshToken } : {}),
      ...(opts.accessTokenExpiresAt ? { accessTokenExpiresAt: opts.accessTokenExpiresAt } : {}),
      ...(opts.refreshTokenExpiresAt ? { refreshTokenExpiresAt: opts.refreshTokenExpiresAt } : {}),
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

  /**
   * Confirm a token is *actually* revoked before deleting it. Called on a 401
   * from any budgeted endpoint instead of removing blindly.
   *
   * GitHub occasionally returns a spurious `401 Bad credentials` for a token
   * that is in fact still valid (auth-subsystem blips / incidents). The old
   * behaviour — delete the integration row on the first 401 — turned every such
   * blip into a permanent, self-inflicted "GitHub disconnected" AND destroyed
   * the evidence: once removed, the token can no longer be health-checked, so we
   * could never tell a genuine server-side revocation from a transient 401.
   *
   * Now we ask the free, app-authenticated check-token endpoint whether the
   * token is dead before removing it:
   *   - 404 (valid:false) → genuinely revoked: remove, logged `token:revocation-confirmed`.
   *   - 200 (valid:true)  → PHANTOM 401: keep the token, log `token:phantom-401`.
   *     The caller still throws so the current poll fails and retries; the token
   *     survives to serve the next call.
   *   - check-token errored (network/timeout/app-auth failure) → inconclusive:
   *     keep the token, log `token:revocation-check-failed`; the next 401 re-checks.
   *     Better a retry than a wrong delete.
   *   - check-token unavailable (no app creds, or token already gone) → fall back
   *     to removing (logged `token:revocation-unconfirmed`) so we never wedge a
   *     poller forever holding a token we have no way to verify.
   */
  async confirmRevokedThenRemove(workspaceId: string, reason: string): Promise<void> {
    const stored = this.tokens.get(workspaceId);
    const fp = stored ? tokenFingerprint(stored.accessToken) : 'none';
    const age = stored ? describeTokenAge(stored.createdAt) : 'unknown';

    let health: TokenHealthCheck | null;
    try {
      health = await this.checkTokenHealth(workspaceId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const summary =
        `[github] workspace ${workspaceId}: 401 received but check-token was INCONCLUSIVE ` +
        `(${message}) — KEEPING token fp:${fp} (age ${age}) for re-check on next 401. ` +
        `Original 401: ${reason}`;
      console.warn(summary);
      debugBus.recordEvent({
        service: 'github',
        action: 'token:revocation-check-failed',
        summary,
        ok: false,
        meta: { workspaceId, fingerprint: fp, tokenAge: age, reason, error: message },
      });
      return;
    }

    if (health === null) {
      // No app credentials to verify with (or the token's already gone). We
      // can't confirm, so fall back to the historical remove-on-401 behaviour
      // rather than hold a possibly-dead token that no-ops every poll.
      const summary =
        `[github] workspace ${workspaceId}: 401 received and check-token UNAVAILABLE ` +
        `(no app creds?) — removing token fp:${fp} (age ${age}) UNCONFIRMED. ` +
        `Original 401: ${reason}`;
      console.warn(summary);
      debugBus.recordEvent({
        service: 'github',
        action: 'token:revocation-unconfirmed',
        summary,
        ok: false,
        meta: { workspaceId, fingerprint: fp, tokenAge: age, reason },
      });
      await this.removeToken(workspaceId, `${reason} [UNCONFIRMED: check-token unavailable]`);
      return;
    }

    if (health.valid) {
      // GitHub says the token is alive — the 401 was spurious. Do NOT delete it.
      const summary =
        `[github] workspace ${workspaceId}: PHANTOM 401 — check-token reports token fp:${fp} ` +
        `(age ${age}) still VALID (login=${health.login ?? 'unknown'} ` +
        `github_created_at=${health.githubCreatedAt ?? 'unknown'} ` +
        `expires_at=${health.expiresAt ?? 'never'}). KEEPING it; the failing call will retry. ` +
        `Original 401: ${reason}`;
      console.warn(summary);
      debugBus.recordEvent({
        service: 'github',
        action: 'token:phantom-401',
        summary,
        ok: false,
        meta: {
          workspaceId,
          fingerprint: fp,
          tokenAge: age,
          login: health.login ?? null,
          githubCreatedAt: health.githubCreatedAt ?? null,
          expiresAt: health.expiresAt ?? null,
          reason,
        },
      });
      return;
    }

    // check-token returned 404: GitHub confirms the token is dead. Removing it
    // here is now a *confirmed* revocation — the distinction we've been unable
    // to make. removeToken logs `token:removed`; this adds the confirmation.
    const summary =
      `[github] workspace ${workspaceId}: CONFIRMED revoked — check-token 404 for token fp:${fp} ` +
      `(age ${age}). Removing. Original 401: ${reason}`;
    console.warn(summary);
    debugBus.recordEvent({
      service: 'github',
      action: 'token:revocation-confirmed',
      summary,
      ok: false,
      meta: { workspaceId, fingerprint: fp, tokenAge: age, reason },
    });
    await this.removeToken(workspaceId, `${reason} [CONFIRMED revoked: check-token 404]`);
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
    const stored = this.tokens.get(workspaceId);
    // App workspaces share the installation's rate bucket — key on it so the
    // gate accounts all of an installation's traffic together.
    if (stored?.installationId && isGitHubAppConfigured()) {
      return `inst:${stored.installationId}`;
    }
    return (
      this.viewerLoginCache.get(workspaceId) ??
      stored?.accessToken ??
      workspaceId
    );
  }

  /**
   * Resolve the auth for one outbound call. App workspaces use a freshly-minted
   * installation token for the data plane (`auto`); viewer-identity endpoints
   * (`/user`, `/user/teams`, …) force the user token with `preferUser`. Legacy
   * OAuth workspaces always return the stored token regardless — so their
   * behaviour (and tests) are unchanged. Returns null when nothing is connected.
   */
  private async resolveAuth(
    workspaceId: string,
    opts: { preferUser?: boolean; owner?: string } = {},
  ): Promise<ResolvedAuth | null> {
    const stored = this.tokens.get(workspaceId);
    // Data-plane calls use an installation token, resolved by the repo's OWNER
    // (a workspace can span accounts/installations). When the owner is KNOWN but
    // no installation covers it, do NOT fall back to the workspace's primary
    // installation — that token is for a different account and would 403
    // ("Resource not accessible by integration"); fall through to the user
    // token, which carries the user's actual access. The primary installation
    // is only the fallback for owner-less calls (e.g. /rate_limit).
    const installationId = opts.owner
      ? this.installationForOwner(opts.owner)
      : stored?.installationId;
    if (installationId && isGitHubAppConfigured() && !opts.preferUser) {
      try {
        const token = await getInstallationToken(installationId);
        return { tokenType: 'token', accessToken: token, kind: 'installation', installationId };
      } catch (err) {
        if (err instanceof InstallationUnavailableError) {
          void this.markInstallationUnavailable(installationId, err.status);
        }
        // Fall through to the user token if we have one — better a degraded
        // viewer-scoped call than a hard failure.
        if (!stored?.accessToken) throw err;
      }
    }
    if (!stored) return null;
    // User-token path. Rotate first if it's an expiring App token near expiry.
    const fresh = await this.ensureFreshUserToken(workspaceId);
    if (!fresh) return null;
    return { tokenType: fresh.tokenType, accessToken: fresh.accessToken, kind: 'user' };
  }

  /**
   * Return the workspace's user token, rotating it first if it's an expiring
   * App token within the refresh window. A non-expiring token (no
   * `accessTokenExpiresAt`/`refreshToken` — classic OAuth, or App with expiry
   * off) is returned as-is. Concurrent callers share one in-flight refresh.
   * Returns null if there's no token, or if a refresh fails (refresh token dead
   * → the user must reconnect; surfaced via a debug event).
   */
  private async ensureFreshUserToken(workspaceId: string): Promise<StoredToken | null> {
    const stored = this.tokens.get(workspaceId);
    if (!stored) return null;
    // Non-expiring token, or expiry not yet near → use as-is.
    if (
      !stored.accessTokenExpiresAt ||
      !stored.refreshToken ||
      stored.accessTokenExpiresAt - Date.now() > GitHubService.USER_TOKEN_REFRESH_SKEW_MS
    ) {
      return stored;
    }

    const inFlight = this.userTokenRefreshes.get(workspaceId);
    if (inFlight) return inFlight;

    const refresh = this.rotateUserToken(workspaceId, stored).finally(() => {
      this.userTokenRefreshes.delete(workspaceId);
    });
    this.userTokenRefreshes.set(workspaceId, refresh);
    return refresh;
  }

  private async rotateUserToken(
    workspaceId: string,
    stored: StoredToken
  ): Promise<StoredToken | null> {
    try {
      const grant = await refreshUserToken(stored.refreshToken!);
      const now = Date.now();
      const updated: StoredToken = {
        ...stored,
        accessToken: grant.access_token,
        tokenType: grant.token_type,
        scope: grant.scope || stored.scope,
        refreshToken: grant.refreshToken ?? stored.refreshToken,
        accessTokenExpiresAt: grant.expiresInSec ? now + grant.expiresInSec * 1000 : undefined,
        refreshTokenExpiresAt: grant.refreshTokenExpiresInSec
          ? now + grant.refreshTokenExpiresInSec * 1000
          : stored.refreshTokenExpiresAt,
      };
      this.tokens.set(workspaceId, updated);
      await this.persistRotatedUserToken(workspaceId, updated);
      debugBus.recordEvent({
        service: 'github',
        action: 'token:user-refreshed',
        summary: `[github] workspace ${workspaceId}: rotated user token fp:${tokenFingerprint(updated.accessToken)}`,
        ok: true,
        workspaceId,
      });
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isDead = err instanceof UserTokenRefreshError;
      debugBus.recordEvent({
        service: 'github',
        action: 'token:user-refresh-failed',
        summary:
          `[github] workspace ${workspaceId}: user-token refresh FAILED (${message})` +
          (isDead ? ' — refresh token dead; user must reconnect via the GitHub App' : ''),
        ok: false,
        workspaceId,
      });
      // A dead refresh token can't recover without re-auth — drop the rotation
      // state so we stop hammering the endpoint; the (now-expiring) token stays
      // until the user reconnects. A transient failure (network/5xx) keeps the
      // refresh token and retries on the next call.
      if (isDead) {
        const cur = this.tokens.get(workspaceId);
        if (cur) {
          this.tokens.set(workspaceId, {
            ...cur,
            refreshToken: undefined,
            accessTokenExpiresAt: undefined,
          });
        }
      }
      return null;
    }
  }

  /**
   * Quietly persist a rotated user token to the integration row — no connect
   * logging/events (unlike storeToken). Read-modify-write so App fields
   * (installationId/authMethod) on the config are preserved.
   */
  private async persistRotatedUserToken(workspaceId: string, token: StoredToken): Promise<void> {
    try {
      const existing = await this.db
        .select({ id: integrationsTable.id, config: integrationsTable.config })
        .from(integrationsTable)
        .where(
          and(eq(integrationsTable.workspaceId, workspaceId), eq(integrationsTable.type, 'github'))
        )
        .limit(1);
      if (!existing[0]) return;
      const prevConfig = (existing[0].config as GitHubIntegrationConfig | null) ?? {};
      const config: GitHubIntegrationConfig = {
        ...prevConfig,
        accessTokenEnc: encryptString(token.accessToken),
        tokenType: token.tokenType,
        scope: token.scope,
        ...(token.refreshToken ? { refreshTokenEnc: encryptString(token.refreshToken) } : {}),
        accessTokenExpiresAt: token.accessTokenExpiresAt
          ? new Date(token.accessTokenExpiresAt).toISOString()
          : undefined,
        refreshTokenExpiresAt: token.refreshTokenExpiresAt
          ? new Date(token.refreshTokenExpiresAt).toISOString()
          : undefined,
      };
      await this.db
        .update(integrationsTable)
        .set({ config, updatedAt: new Date() })
        .where(eq(integrationsTable.id, existing[0].id));
    } catch (err) {
      // In-memory token is already updated; a failed persist just means we
      // re-rotate after a restart. Log, don't throw into the request path.
      console.error(`[github] failed to persist rotated user token for ${workspaceId}:`, err);
    }
  }

  /**
   * Flag an installation as suspended/removed in the DB so the webhook receiver
   * stops enqueuing its deliveries. Best-effort, fire-and-forget. Defined here
   * (not imported) to avoid a hard dependency cycle with the install routes.
   */
  private async markInstallationUnavailable(installationId: string, status: number): Promise<void> {
    try {
      const { githubInstallations } = await import('../db/schema.js');
      await this.db
        .update(githubInstallations)
        .set({ suspendedAt: new Date(), updatedAt: new Date() })
        .where(eq(githubInstallations.installationId, installationId));
      debugBus.recordEvent({
        service: 'github',
        action: 'installation:unavailable',
        ok: false,
        summary: `installation ${installationId} unavailable (${status}) — marked suspended`,
      });
    } catch (err) {
      console.error('Failed to mark installation suspended:', err);
    }
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
    options: RequestInit = {},
    auth: 'auto' | 'user' = 'auto'
  ): Promise<T> {
    const resolved = await this.resolveAuth(workspaceId, {
      preferUser: auth === 'user',
      owner: ownerFromEndpoint(endpoint),
    });
    if (!resolved) {
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
          Authorization: `${resolved.tokenType} ${resolved.accessToken}`,
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
        if (resolved.kind === 'installation' && resolved.installationId) {
          // A stale installation token — drop it from the mint cache so the
          // next call re-mints from a fresh App JWT. Do NOT touch the user
          // integration row; the installation token is ephemeral.
          clearInstallationToken(resolved.installationId);
        } else {
          // GitHub's body says WHY ("Bad credentials" = revoked/invalid vs
          // "...token expired") and the request id lets GitHub support trace it.
          // Confirm the token is actually dead (check-token 404) before deleting —
          // a spurious 401 must not nuke a working token. See confirmRevokedThenRemove.
          await this.confirmRevokedThenRemove(
            workspaceId,
            `401 on ${method} ${redactUrl(url)} — body: ${bodyText.slice(0, 200) || '(empty)'}, ` +
              `request-id: ${response.headers.get('x-github-request-id') ?? 'n/a'}`
          );
        }
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
    // Viewer identity — must use the user-to-server token (an installation
    // token has no `/user`).
    return this.apiRequest<GitHubUser>(workspaceId, '/user', {}, 'user');
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
      >(workspaceId, '/user/teams?per_page=100', {}, 'user');
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
    // "What can the human see" — user-token scoped.
    return this.paginate<GitHubRepo>(
      workspaceId,
      (page) =>
        `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      20,
      'user'
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
        (page) => `/user/orgs?per_page=100&page=${page}`,
        20,
        'user'
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
    maxPages = 20,
    auth: 'auto' | 'user' = 'auto'
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.apiRequest<T[]>(workspaceId, urlForPage(page), {}, auth);
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
    // Resolve app creds at call time (not the import-time consts): this is the
    // forensic path the 401 guard depends on, and it must not silently no-op if
    // the env was populated after module load. For an App-connected workspace,
    // the user token belongs to the GitHub App, so the check-token call must use
    // the App's client credentials — falling back to the classic-OAuth app's.
    const isApp = Boolean(stored?.installationId);
    const clientId = (isApp ? process.env.GITHUB_APP_CLIENT_ID : '') || process.env.GITHUB_CLIENT_ID || GITHUB_CLIENT_ID;
    const clientSecret = (isApp ? process.env.GITHUB_APP_CLIENT_SECRET : '') || process.env.GITHUB_CLIENT_SECRET || GITHUB_CLIENT_SECRET;
    if (!stored || !clientId || !clientSecret) return null;
    const fingerprint = tokenFingerprint(stored.accessToken);
    const url = `${GITHUB_API_URL}/applications/${clientId}/token`;
    const startedAt = Date.now();
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
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
      return {
        workspaceId,
        fingerprint,
        prefix: tokenPrefix(stored.accessToken),
        storedCreatedAt: stored.createdAt,
        valid: false,
      };
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
      prefix: tokenPrefix(stored.accessToken),
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
    // Every batched query passes `owner` in its variables — use it to resolve
    // the right installation when the workspace spans multiple accounts.
    const owner = typeof variables.owner === 'string' ? variables.owner : undefined;
    const resolved = await this.resolveAuth(workspaceId, { owner });
    if (!resolved) {
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
            Authorization: `${resolved.tokenType} ${resolved.accessToken}`,
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
          errors?: Array<{ message: string; type?: string; path?: Array<string | number> }>;
        }>(response.bodyText);
        if (payload.errors && payload.errors.length > 0) {
          // GitHub returns *partial* data alongside per-field FORBIDDEN errors:
          // when the installation can read an object but not one of its leaf
          // fields (e.g. …statusCheckRollup.contexts.nodes.N.isRequired needs
          // branch-protection read, …checkSuite.app can 403 on suites owned by
          // an app we can't see) that leaf comes back null and the error names
          // its deep path. Keep the data and drop the leaf rather than
          // discarding the whole response — otherwise a single forbidden
          // sub-field sinks an entire PR refresh, and callers that match on
          // "Resource not accessible by integration" (prMonitor's
          // isRepoAccessError) misread it as the *whole repo* being
          // inaccessible and stop polling it.
          //
          // Only tolerate when every error is a deep-path FORBIDDEN (path
          // length > 2, i.e. well past the `repository` root) and we still got
          // a data payload. A root-level FORBIDDEN/NOT_FOUND (genuine
          // no-access), any non-FORBIDDEN error, or a null `data` stays fatal
          // and is surfaced verbatim with its type + path — that's the actual
          // signal repo-access classification depends on.
          const isLeafForbidden = (e: {
            type?: string;
            path?: Array<string | number>;
          }) => e.type === 'FORBIDDEN' && Array.isArray(e.path) && e.path.length > 2;
          const tolerable =
            payload.data != null && payload.errors.every(isLeafForbidden);
          if (!tolerable) {
            // Surface the first GraphQL error verbatim, plus its `type`
            // (e.g. FORBIDDEN) and `path` — which field/node GitHub refused.
            const e = payload.errors[0];
            const detail =
              (e.type ? ` [${e.type}]` : '') +
              (e.path ? ` at ${e.path.join('.')}` : '');
            recordGql(false, `GraphQL: ${e.message}${detail}`);
            throw new Error(`GitHub GraphQL: ${e.message}${detail}`);
          }
          // Partial success — record the forbidden leaves so the Debug panel
          // isn't blind to them, but don't fail the request.
          recordGql(true, `partial: ${payload.errors.length} forbidden leaf(s)`);
          // `tolerable` already verified data != null; the const boolean just
          // doesn't carry the narrowing.
          return payload.data as T;
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
        if (resolved.kind === 'installation' && resolved.installationId) {
          clearInstallationToken(resolved.installationId);
        } else {
          await this.confirmRevokedThenRemove(
            workspaceId,
            `401 on POST /graphql — body: ${response.bodyText.slice(0, 200) || '(empty)'}, ` +
              `request-id: ${response.headers.get('x-github-request-id') ?? 'n/a'}`
          );
        }
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
