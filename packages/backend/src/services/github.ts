import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import { integrations as integrationsTable } from '../db/schema.js';
import {
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from './tokenCrypto.js';

// GitHub OAuth configuration. Set via environment variables in production.
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_REDIRECT_URI =
  process.env.GITHUB_REDIRECT_URI || 'http://localhost:4747/api/v1/github/callback';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

const GITHUB_SCOPES = ['repo', 'read:user', 'read:org'];

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

interface StoredToken {
  workspaceId: string;
  accessToken: string;
  tokenType: string;
  scope: string;
  createdAt: string;
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

      for (const row of rows) {
        const config = row.config as GitHubIntegrationConfig | null;
        if (!config) continue;
        const accessToken = readAccessToken(config);
        if (!accessToken) continue;
        this.tokens.set(row.workspaceId, {
          workspaceId: row.workspaceId,
          accessToken,
          tokenType: config.tokenType || 'bearer',
          scope: config.scope || '',
          createdAt: config.createdAt || new Date().toISOString(),
        });
      }

      console.log(`Loaded ${this.tokens.size} GitHub tokens`);
    } catch (err) {
      console.error('Failed to load GitHub tokens:', err);
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
    const response = await fetch(GITHUB_TOKEN_URL, {
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

    if (!response.ok) {
      throw new Error(`GitHub token exchange failed: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
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

    this.tokens.set(workspaceId, {
      workspaceId,
      accessToken,
      tokenType,
      scope,
      createdAt,
    });
    this.emit('connected', workspaceId);
  }

  async removeToken(workspaceId: string): Promise<void> {
    await this.db
      .delete(integrationsTable)
      .where(
        and(eq(integrationsTable.workspaceId, workspaceId), eq(integrationsTable.type, 'github'))
      );
    this.tokens.delete(workspaceId);
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

  private async apiRequest<T>(
    workspaceId: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.tokens.get(workspaceId);
    if (!token) {
      throw new Error('GitHub not connected for this workspace');
    }

    const response = await fetch(`${GITHUB_API_URL}${endpoint}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `${token.tokenType} ${token.accessToken}`,
        'User-Agent': 'FastOwl',
        ...options.headers,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        await this.removeToken(workspaceId);
        throw new Error('GitHub token expired or revoked');
      }
      throw new Error(`GitHub API error: ${response.statusText}`);
    }

    return response.json();
  }

  async getUser(workspaceId: string): Promise<GitHubUser> {
    return this.apiRequest<GitHubUser>(workspaceId, '/user');
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
    const response = await fetch(`${GITHUB_API_URL}/graphql`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `${token.tokenType} ${token.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'FastOwl',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      if (response.status === 401) {
        await this.removeToken(workspaceId);
        throw new Error('GitHub token expired or revoked');
      }
      throw new Error(`GitHub GraphQL error: ${response.statusText}`);
    }
    const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (payload.errors && payload.errors.length > 0) {
      // Surface the first GraphQL error verbatim — callers want to see
      // "Resource not accessible" or "Could not resolve to a Repository"
      // rather than a generic 200-but-failed.
      throw new Error(`GitHub GraphQL: ${payload.errors[0].message}`);
    }
    if (!payload.data) {
      throw new Error('GitHub GraphQL response missing data');
    }
    return payload.data;
  }
}

export const githubService = new GitHubService();
