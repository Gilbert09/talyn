import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import {
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';
import { githubService } from './github.js';
import {
  batchPullRequestsByNumber,
  type BatchPRByNumberResult,
} from './githubGraphql.js';
import { upsertFromBatchResult } from './prCache.js';
import { ttlFor } from './prFocus.js';

interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
  /**
   * Absolute path where this repo is cloned on the environment's host.
   * Required before any agent task can run against the repo — the
   * create-task modal filters out repos without one.
   */
  localPath?: string;
  defaultBranch: string;
}

// Tick at the focused TTL so a focused PR can be re-checked the
// instant it ages past 30 s. Unfocused PRs hit a 60 s TTL inside
// `filterStale` so they only get refetched every other tick.
const POLL_INTERVAL_MS = 30_000;

// GitHub computes `mergeable` lazily: the first query kicks off a
// background job and returns UNKNOWN, and every base-branch push resets it
// to UNKNOWN until recomputed. On a busy repo a single poll usually lands
// on UNKNOWN, which renders as a blank status pill. Re-query the still-
// UNKNOWN open PRs a few times with a short backoff so we persist the
// resolved MERGEABLE/CONFLICTING instead.
const UNKNOWN_MERGEABLE_RETRIES = 3;
const UNKNOWN_MERGEABLE_BACKOFF_MS = 1_500;

class PRMonitorService extends EventEmitter {
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  /** Cached current-user logins keyed by workspaceId — saves a round-trip
   *  per poll. Cleared when the OAuth token rotates (via removeToken). */
  private userLoginCache: Map<string, string> = new Map();

  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    // Drop the cached login if the OAuth token gets revoked or
    // disconnected — otherwise the next poll would still try to use
    // the previous user's login as a filter.
    githubService.on('disconnected', (workspaceId: string) => {
      this.invalidateUserLogin(workspaceId);
    });
    this.startPolling();
  }

  shutdown(): void {
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    console.log('Starting PR monitor polling...');
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    setTimeout(() => this.poll(), 5_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------- Repo CRUD (unchanged surface, used by /repositories) ----------

  async getWatchedRepos(workspaceId: string): Promise<WatchedRepo[]> {
    const rows = await this.db
      .select({
        id: repositoriesTable.id,
        workspaceId: repositoriesTable.workspaceId,
        name: repositoriesTable.name,
        url: repositoriesTable.url,
        localPath: repositoriesTable.localPath,
        defaultBranch: repositoriesTable.defaultBranch,
      })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.workspaceId, workspaceId));

    return rows
      .map((row): WatchedRepo | null => {
        const match = row.url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
        if (!match) return null;
        const entry: WatchedRepo = {
          id: row.id,
          workspaceId: row.workspaceId,
          owner: match[1],
          repo: match[2].replace(/\.git$/, ''),
          fullName: `${match[1]}/${match[2].replace(/\.git$/, '')}`,
          defaultBranch: row.defaultBranch,
        };
        if (row.localPath) entry.localPath = row.localPath;
        return entry;
      })
      .filter((r): r is WatchedRepo => r !== null);
  }

  async addWatchedRepo(
    workspaceId: string,
    owner: string,
    repo: string,
    url?: string,
    localPath?: string
  ): Promise<WatchedRepo> {
    const id = uuid();
    const fullName = `${owner}/${repo}`;
    const repoUrl = url || `https://github.com/${fullName}`;
    const defaultBranch = 'main';

    await this.db.insert(repositoriesTable).values({
      id,
      workspaceId,
      name: fullName,
      url: repoUrl,
      localPath: localPath ?? null,
      defaultBranch,
      createdAt: new Date(),
    });

    return {
      id,
      workspaceId,
      owner,
      repo,
      fullName,
      localPath,
      defaultBranch,
    };
  }

  /**
   * Patch a watched repo's editable fields. Currently just `localPath`
   * — the user sets this after clicking Add so the repo has somewhere
   * to run tasks against.
   */
  async updateWatchedRepo(
    id: string,
    updates: { localPath?: string | null }
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (updates.localPath !== undefined) patch.localPath = updates.localPath;
    if (Object.keys(patch).length === 0) return;
    await this.db
      .update(repositoriesTable)
      .set(patch)
      .where(eq(repositoriesTable.id, id));
  }

  async removeWatchedRepo(repoId: string): Promise<void> {
    await this.db.delete(repositoriesTable).where(eq(repositoriesTable.id, repoId));
  }

  // ---------- Polling ----------

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const connectedWorkspaces = githubService.getConnectedWorkspaces();
      for (const workspaceId of connectedWorkspaces) {
        try {
          await this.pollWorkspace(workspaceId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.error(`PR monitor: workspace ${workspaceId.slice(0, 8)} poll failed:`, msg);
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * One workspace per tick. Per repo:
   *   1. Search for the connected user's open PRs (authored +
   *      review-requested). Search — not "list the repo's open PRs and
   *      filter" — because a big repo (hundreds of open PRs) buries the
   *      user's own beyond the first page, dropping them silently.
   *   2. For the stale ones, call `batchPullRequestsByNumber` for the
   *      GraphQL summary + checks rollup in one round-trip per chunk.
   *   3. For each result, hand off to `prCache.upsertFromBatchResult`
   *      — that's where the cursor diff runs and inbox items get
   *      emitted.
   *   4. Sweep any tracked PRs we own in the DB but didn't see in the
   *      search and mark them closed/merged so the GitHub page stops
   *      actively polling them.
   */
  private async pollWorkspace(workspaceId: string): Promise<void> {
    const login = await this.resolveCurrentUser(workspaceId);
    if (!login) return;
    const repos = await this.getWatchedRepos(workspaceId);

    for (const repo of repos) {
      try {
        await this.pollRepo(workspaceId, repo, login);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.error(`PR monitor: ${repo.fullName} poll failed:`, msg);
      }
    }
  }

  private async pollRepo(
    workspaceId: string,
    repo: WatchedRepo,
    currentUserLogin: string
  ): Promise<void> {
    // Two scoped searches: PRs the user authored, and PRs awaiting their
    // review. Each returns exactly the matches regardless of how many
    // open PRs the repo has overall.
    const full = `${repo.owner}/${repo.repo}`;
    // Three scoped searches:
    //   - authored: PRs the user opened.
    //   - review-requested: PRs awaiting the user's review, INCLUDING ones
    //     where only a team they're on was asked.
    //   - user-review-requested: the subset where the user is named
    //     *individually*. Lets the GitHub page keep an approved PR on the
    //     Review list only when the user was explicitly asked.
    const [authored, reviewRequested, explicitlyReviewRequested] = await Promise.all([
      githubService.searchPullRequestNumbers(
        workspaceId,
        `repo:${full} is:pr is:open author:${currentUserLogin}`
      ),
      githubService.searchPullRequestNumbers(
        workspaceId,
        `repo:${full} is:pr is:open review-requested:${currentUserLogin}`
      ),
      githubService.searchPullRequestNumbers(
        workspaceId,
        `repo:${full} is:pr is:open user-review-requested:${currentUserLogin}`
      ),
    ]);
    // number → "the user is a requested reviewer (not the author)".
    const reviewRequestedByNumber = new Map<number, boolean>();
    for (const n of authored) reviewRequestedByNumber.set(n, false);
    for (const n of reviewRequested) {
      if (!reviewRequestedByNumber.has(n)) reviewRequestedByNumber.set(n, true);
    }
    const explicitlyRequestedNumbers = new Set(explicitlyReviewRequested);
    const watchedNumbers = Array.from(reviewRequestedByNumber.keys());

    if (watchedNumbers.length === 0) {
      await this.sweepClosed(workspaceId, repo, []);
      return;
    }

    // Determine which PRs are actually stale enough to need a refetch
    // (saves the GraphQL call when nothing has aged past the TTL).
    const staleNumbers = await this.filterStale(workspaceId, repo.id, watchedNumbers);
    if (staleNumbers.length === 0) {
      // Still sweep closed — the user might have merged something
      // outside the TTL window.
      await this.sweepClosed(workspaceId, repo, watchedNumbers);
      return;
    }

    const results = await this.resolveUnknownMergeable(
      workspaceId,
      repo,
      await batchPullRequestsByNumber({
        workspaceId,
        owner: repo.owner,
        repo: repo.repo,
        numbers: staleNumbers,
      })
    );

    for (const result of results) {
      if (!result.pr) continue;
      await upsertFromBatchResult({
        workspaceId,
        repositoryId: repo.id,
        summary: result.pr,
        reviewRequested: reviewRequestedByNumber.get(result.pr.number) ?? false,
        explicitlyReviewRequested: explicitlyRequestedNumbers.has(result.pr.number),
      });
    }

    await this.sweepClosed(workspaceId, repo, watchedNumbers);
  }

  /**
   * Resolve PRs GitHub returned with `mergeable: UNKNOWN` (open PRs only —
   * merged/closed have no meaningful mergeability). GitHub computes it
   * lazily, so the first query triggers the job and a follow-up a moment
   * later returns the real value. Re-query the UNKNOWN ones a few times
   * with a short backoff and splice resolved summaries back in. Returns a
   * new results array; gives up (keeping UNKNOWN) after the retry budget.
   */
  private async resolveUnknownMergeable(
    workspaceId: string,
    repo: WatchedRepo,
    results: BatchPRByNumberResult[]
  ): Promise<BatchPRByNumberResult[]> {
    const byNumber = new Map(results.map((r) => [r.number, r]));
    let pending = results
      .filter((r) => r.pr?.state === 'open' && r.pr.mergeable === 'UNKNOWN')
      .map((r) => r.number);
    if (pending.length === 0) return results;

    for (let attempt = 0; attempt < UNKNOWN_MERGEABLE_RETRIES && pending.length > 0; attempt++) {
      await delay(UNKNOWN_MERGEABLE_BACKOFF_MS);
      const refetched = await batchPullRequestsByNumber({
        workspaceId,
        owner: repo.owner,
        repo: repo.repo,
        numbers: pending,
      });
      const stillPending: number[] = [];
      for (const r of refetched) {
        if (r.pr) byNumber.set(r.number, r);
        if (r.pr?.state === 'open' && r.pr.mergeable === 'UNKNOWN') {
          stillPending.push(r.number);
        }
      }
      pending = stillPending;
    }
    if (pending.length > 0) {
      console.log(
        `[prMonitor] ${repo.owner}/${repo.repo}: ${pending.length} PR(s) still UNKNOWN mergeable after ${UNKNOWN_MERGEABLE_RETRIES} retries — GitHub still computing`
      );
    }
    return results.map((r) => byNumber.get(r.number) ?? r);
  }

  private async filterStale(
    workspaceId: string,
    repositoryId: string,
    numbers: number[]
  ): Promise<number[]> {
    if (numbers.length === 0) return [];
    const rows = await this.db
      .select({
        id: pullRequestsTable.id,
        number: pullRequestsTable.number,
        lastPolledAt: pullRequestsTable.lastPolledAt,
      })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId)
        )
      );
    // Build (number → { id, lastPolledAt }) so we can ask prFocus
    // whether each PR is focused/in-cooldown. The id matches the
    // `pull_requests.id` we hand out in /pull-requests/:id/focus.
    const cached = new Map<number, { id: string; lastPolledAt: Date }>();
    for (const row of rows) {
      if (numbers.includes(row.number)) {
        cached.set(row.number, { id: row.id, lastPolledAt: row.lastPolledAt });
      }
    }
    const now = Date.now();
    return numbers.filter((number) => {
      const entry = cached.get(number);
      if (!entry) return true; // never seen; always stale
      // Per-PR TTL: focused = 30 s, unfocused = 60 s, cooldown =
      // effectively infinite. The poll tick fires every 30 s so a
      // focused PR can refetch the moment it ages out.
      const ttl = ttlFor(workspaceId, entry.id);
      return now - entry.lastPolledAt.getTime() >= ttl;
    });
  }

  /**
   * Mark any DB row we've been polling as closed/merged once it stops
   * appearing in the open-PR list. Stops the row from being repolled
   * but keeps the row around so the user can filter "merged PRs from
   * my old tasks" on the GitHub page.
   *
   * Disambiguates merged vs closed by hitting the per-PR REST endpoint
   * (`merged_at` is the canonical signal). The batch GraphQL query
   * filters on `states: [OPEN]`, so it can't tell us — and without
   * this distinction every merged PR ends up wrongly stuck in the
   * Closed tab. On REST failure we fall back to 'closed' so a flaky
   * call doesn't keep repolling the row forever.
   */
  private async sweepClosed(
    workspaceId: string,
    repo: WatchedRepo,
    seenNumbers: number[]
  ): Promise<void> {
    const rows = await this.db
      .select({ number: pullRequestsTable.number, id: pullRequestsTable.id })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repo.id),
          eq(pullRequestsTable.state, 'open')
        )
      );
    const seen = new Set(seenNumbers);
    const stale = rows.filter((r) => !seen.has(r.number));
    if (stale.length === 0) return;
    for (const row of stale) {
      let nextState: 'merged' | 'closed' = 'closed';
      let mergedAt: Date | null = null;
      try {
        const pr = await githubService.getPullRequest(
          workspaceId,
          repo.owner,
          repo.repo,
          row.number
        );
        // A review-requested PR drops out of our watch list the moment
        // the user submits their review, but stays OPEN on GitHub. Don't
        // mark such a PR closed — leave its state untouched.
        if (pr.state === 'open' && !pr.merged_at && !pr.merged) {
          continue;
        }
        if (pr.merged_at || pr.merged) {
          nextState = 'merged';
          mergedAt = pr.merged_at ? new Date(pr.merged_at) : new Date();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn(
          `[pr-monitor] sweep state lookup failed for ${repo.fullName}#${row.number}: ${msg}`
        );
      }
      await this.db
        .update(pullRequestsTable)
        .set({ state: nextState, mergedAt, updatedAt: new Date() })
        .where(eq(pullRequestsTable.id, row.id));
    }
  }

  private async resolveCurrentUser(workspaceId: string): Promise<string | null> {
    const cached = this.userLoginCache.get(workspaceId);
    if (cached) return cached;
    try {
      const user = await githubService.getUser(workspaceId);
      this.userLoginCache.set(workspaceId, user.login);
      return user.login;
    } catch {
      return null;
    }
  }

  /**
   * Test/admin entry point. Drains any in-flight tick before running a
   * fresh one, so callers can rely on "after this resolves, every
   * connected workspace's PRs were just refreshed".
   */
  async forcePoll(): Promise<void> {
    while (this.isPolling) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.poll();
  }

  /**
   * Drop a cached login — called when a workspace's GitHub OAuth token
   * is removed (revoked / disconnected). Without this, the next poll
   * would still try to use the previous user's login as a filter.
   */
  invalidateUserLogin(workspaceId: string): void {
    this.userLoginCache.delete(workspaceId);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const prMonitorService = new PRMonitorService();
