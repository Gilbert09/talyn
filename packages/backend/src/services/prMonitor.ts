import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import { getPoolDbClient, type Database } from '../db/client.js';
import {
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { githubService } from './github.js';
import {
  batchPullRequestsByNumber,
  type BatchPRByNumberResult,
  type PRSummary,
} from './githubGraphql.js';
import { upsertFromBatchResult } from './prCache.js';
import { ttlFor, isCohortActive, isInCooldown } from './prFocus.js';
import { emitPullRequestUpdated } from './websocket.js';
import {
  broadcastMergeQueuePositions,
  QUEUE_RESET_COLUMNS,
} from './mergeQueueBroadcast.js';
import { debugBus } from './debugBus.js';
import { TickGuard } from './tickGuard.js';
import { rateBudgetGovernor } from './rateBudgetGovernor.js';

interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
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

// Active-CI fast loop: authored PRs whose checks are still running change
// state fast (CI settling, mergeability flipping), so they get a dedicated
// ~10 s loop that hits GraphQL directly — no Search calls, so it sidesteps
// the 30/min Search limit entirely. Self-draining: a PR leaves the set the
// moment its checks settle. Capped so a burst of building PRs can't blow up.
const ACTIVE_CI_INTERVAL_MS = 10_000;
const ACTIVE_CI_MAX_PER_WORKSPACE = 15;

// Adaptive cadence: when an account is burning its GitHub budget faster than the
// reset window can replenish it, the rate-budget governor returns a factor > 1
// and we stretch the poll interval so usage glides under the limit. Cap the
// stretch so a starved account still gets polled occasionally.
const MAX_POLL_INTERVAL_MS = 5 * 60_000;
const MAX_FAST_INTERVAL_MS = 60_000;

// How long a forced poll (user-facing Refresh) waits for an in-flight tick
// before giving up. Keeps `POST /repositories/poll` bounded — see
// `drainInFlightTick`.
const FORCE_POLL_DRAIN_MS = 15_000;

const MAIN_POLLER_DESC =
  "The baseline PR poll: per workspace, searches the user's open authored + review-requested PRs, batch-fetches summaries/checks via GraphQL, upserts the cache, and reconciles closed/merged PRs. Cadence adapts to the account's remaining GitHub rate-limit budget.";
const FAST_POLLER_DESC =
  'Fast loop for authored PRs with in-flight CI — re-queries GraphQL directly (no Search calls) so settling checks and flipping mergeability update quickly. Self-draining once checks settle. Cadence adapts to remaining GitHub budget.';

class PRMonitorService extends EventEmitter {
  private pollTimer: NodeJS.Timeout | null = null;
  private fastTimer: NodeJS.Timeout | null = null;
  // Wedge watchdogs: a single stalled await must never silently stop the
  // monitor — when this loop freezes, closed/merged PRs are never swept, so
  // a merged queue head looks "open" forever and the merge queue stalls with
  // it (observed in prod, June 2026). See TickGuard.
  private pollGuard = new TickGuard('prMonitor');
  private fastGuard = new TickGuard('prMonitor.fastPoll');
  /** Cached current-user logins keyed by workspaceId — saves a round-trip
   *  per poll. Cleared when the OAuth token rotates (via removeToken). */
  private userLoginCache: Map<string, string> = new Map();

  private get db(): Database {
    // The monitor is a background, cross-owner service: its global poll
    // (incl. the admin-triggered forcePoll) must see every workspace, so it
    // always uses the pool — never an owner-scoped request transaction.
    return getPoolDbClient();
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
    if (this.pollTimer || this.fastTimer) return;
    console.log('Starting PR monitor polling...');
    debugBus.registerPoller('pr_monitor', POLL_INTERVAL_MS, MAIN_POLLER_DESC, POLL_INTERVAL_MS);
    debugBus.registerPoller(
      'pr_monitor_fast_ci',
      ACTIVE_CI_INTERVAL_MS,
      FAST_POLLER_DESC,
      ACTIVE_CI_INTERVAL_MS,
    );
    // Both loops self-schedule via setTimeout (not setInterval) so each tick can
    // re-read the adaptive interval. Kick the main poll ~5s after boot.
    this.pollTimer = setTimeout(() => {
      void this.poll()
        .catch((err) => console.error('PR monitor: tick crashed:', err))
        .finally(() => this.scheduleMain());
    }, 5_000);
    this.scheduleFast();
  }

  /**
   * Loop-wide slowdown factor: the max governor factor across every connected
   * account's budget. The loop iterates all workspaces in one tick, so it paces
   * to the most-constrained account (usually there's just one).
   */
  private loopDelayFactor(): number {
    const keys = new Set<string>();
    for (const ws of githubService.getConnectedWorkspaces()) {
      keys.add(githubService.accountKeyFor(ws));
    }
    return rateBudgetGovernor.maxDelayFactor(keys);
  }

  private scheduleMain(): void {
    const interval = Math.min(POLL_INTERVAL_MS * this.loopDelayFactor(), MAX_POLL_INTERVAL_MS);
    // Reflect the live (possibly stretched) cadence in the Debug panel, keeping
    // the base so the panel can flag when we've been throttled.
    debugBus.registerPoller('pr_monitor', interval, MAIN_POLLER_DESC, POLL_INTERVAL_MS);
    this.pollTimer = setTimeout(() => {
      void this.poll()
        .catch((err) => console.error('PR monitor: tick crashed:', err))
        .finally(() => this.scheduleMain());
    }, interval);
  }

  private scheduleFast(): void {
    const interval = Math.min(
      ACTIVE_CI_INTERVAL_MS * this.loopDelayFactor(),
      MAX_FAST_INTERVAL_MS,
    );
    debugBus.registerPoller(
      'pr_monitor_fast_ci',
      interval,
      FAST_POLLER_DESC,
      ACTIVE_CI_INTERVAL_MS,
    );
    this.fastTimer = setTimeout(() => {
      void this.fastPoll()
        .catch((err) => console.error('PR monitor: fast tick crashed:', err))
        .finally(() => this.scheduleFast());
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fastTimer) {
      clearTimeout(this.fastTimer);
      this.fastTimer = null;
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
        defaultBranch: repositoriesTable.defaultBranch,
      })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.workspaceId, workspaceId));

    return rows
      .map((row): WatchedRepo | null => {
        const match = row.url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
        if (!match) return null;
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          owner: match[1],
          repo: match[2].replace(/\.git$/, ''),
          fullName: `${match[1]}/${match[2].replace(/\.git$/, '')}`,
          defaultBranch: row.defaultBranch,
        };
      })
      .filter((r): r is WatchedRepo => r !== null);
  }

  async addWatchedRepo(
    workspaceId: string,
    owner: string,
    repo: string,
    url?: string
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
      defaultBranch,
      createdAt: new Date(),
    });

    return { id, workspaceId, owner, repo, fullName, defaultBranch };
  }

  async removeWatchedRepo(repoId: string): Promise<void> {
    await this.db.delete(repositoriesTable).where(eq(repositoriesTable.id, repoId));
  }

  // ---------- Polling ----------

  private async poll(): Promise<void> {
    if (!this.pollGuard.tryBegin()) return;
    const startedAt = Date.now();
    let count = 0;
    try {
      const connectedWorkspaces = githubService.getConnectedWorkspaces();
      count = connectedWorkspaces.length;
      for (const workspaceId of connectedWorkspaces) {
        try {
          await this.pollWorkspace(workspaceId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.error(`PR monitor: workspace ${workspaceId.slice(0, 8)} poll failed:`, msg);
        }
      }
    } finally {
      this.pollGuard.end();
      debugBus.pollerTick('pr_monitor', {
        durationMs: Date.now() - startedAt,
        ok: true,
        summary: `pr_monitor tick — ${count} workspace${count === 1 ? '' : 's'}`,
      });
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
   *      — that's where the cursor diff runs and the row's PR-event
   *      cursors are advanced.
   *   4. Sweep any tracked PRs we own in the DB but didn't see in the
   *      search and mark them closed/merged so the GitHub page stops
   *      actively polling them.
   */
  /**
   * Full re-poll of one workspace, on demand. The bulk-refresh fallback: run on
   * App (re)connect, after a paused→active transition, and by the low-frequency
   * reconcile sweep to catch any webhook deliveries that were dropped or missed.
   * Re-derives buckets + summaries exactly as a scheduled tick would.
   */
  async refreshWorkspaceNow(workspaceId: string): Promise<void> {
    await this.pollWorkspace(workspaceId);
  }

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
    //   - authored: PRs the user opened ("Mine").
    //   - review-requested: PRs the user is asked to review, INCLUDING ones
    //     where only a team they're on was asked.
    //   - reviewed-by: PRs the user has already reviewed (approved, requested
    //     changes, or commented).
    // "Awaiting my review" = review-requested MINUS reviewed-by (and minus my
    // own PRs). GitHub drops you from a PR's *individual* request once you
    // review it, but leaves a *team* request standing — so subtracting
    // reviewed-by is what actually clears an approved PR off the list.
    // Run the three searches SERIALLY, not concurrently. GitHub explicitly asks
    // for serial requests per user and is most aggressive about secondary rate
    // limits on the tight `search` budget (30/min) — three concurrent searches
    // per repo was the main trigger for the "exceeded a secondary rate limit"
    // 403s. (The github layer also serializes searches per account as a backstop
    // across repos/workspaces.)
    const authoredNums = await githubService.searchPullRequestNumbers(
      workspaceId,
      `repo:${full} is:pr is:open author:${currentUserLogin}`
    );
    const requestedNums = await githubService.searchPullRequestNumbers(
      workspaceId,
      `repo:${full} is:pr is:open review-requested:${currentUserLogin}`
    );
    const reviewedNums = await githubService.searchPullRequestNumbers(
      workspaceId,
      `repo:${full} is:pr is:open reviewed-by:${currentUserLogin}`
    );
    const authoredSet = new Set(authoredNums);
    const reviewedSet = new Set(reviewedNums);
    const pendingSet = new Set<number>();
    for (const n of requestedNums) {
      if (!reviewedSet.has(n) && !authoredSet.has(n)) pendingSet.add(n);
    }
    // Watch everything we have any relationship with — incl. reviewed
    // review-requested PRs, so their summary stays fresh and the reconcile
    // pass below sees them — but only pendingSet drives the review flag.
    const watchedNumbers = Array.from(new Set([...authoredNums, ...requestedNums]));

    // Tracked-open rows that have fallen out of all three searches (e.g. a PR
    // we were review-requested on, then reviewed, that's still open on
    // GitHub). They never reappear in the search, so without folding them in
    // here their summary — CI, mergeable, title — would freeze forever while
    // the row stays visible on the GitHub page. Refresh them too, on the
    // slacker UNTRACKED TTL (focus still overrides via `filterStale`).
    const watchedSet = new Set(watchedNumbers);
    const untrackedOpen = (await this.getTrackedOpenNumbers(workspaceId, repo.id)).filter(
      (n) => !watchedSet.has(n)
    );
    const untrackedSet = new Set(untrackedOpen);
    const candidateNumbers = [...watchedNumbers, ...untrackedOpen];

    // Determine which PRs are actually stale enough to need a refetch
    // (saves the GraphQL call when nothing has aged past the TTL).
    const staleNumbers = candidateNumbers.length
      ? await this.filterStale(workspaceId, repo.id, candidateNumbers, untrackedSet)
      : [];

    if (staleNumbers.length > 0) {
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
        await this.annotateReviewRequest(workspaceId, result.pr);
        await upsertFromBatchResult({
          workspaceId,
          repositoryId: repo.id,
          summary: result.pr,
          reviewRequested: pendingSet.has(result.pr.number),
          authored: authoredSet.has(result.pr.number),
        });
      }
    }

    await this.sweepClosed(workspaceId, repo, watchedNumbers);
    // Reconcile relationship flags against the authoritative search results
    // for EVERY tracked-open row — not just the freshly-upserted ones — so a
    // PR whose flag should change but which didn't need a summary refetch
    // (e.g. it fell out of review-requested, or the user just reviewed it)
    // still flips. Without this an approved PR lingers on the Review list.
    await this.reconcileRelationshipFlags(workspaceId, repo.id, authoredSet, pendingSet);
  }

  /**
   * Bring each tracked-open row's `authored` / `reviewRequested` flags into
   * line with the current search results, emitting `pull_request:updated`
   * for any row that changed so the GitHub page re-buckets it live. Only
   * touches rows whose flags actually differ.
   */
  private async reconcileRelationshipFlags(
    workspaceId: string,
    repositoryId: string,
    authoredSet: Set<number>,
    pendingSet: Set<number>
  ): Promise<void> {
    // Note: `lastSummary` is deliberately NOT selected here — most ticks
    // change zero rows, so pulling the ~2KB summary jsonb for every open PR
    // was pure egress waste. The rare changed row re-fetches just its own
    // summary below before emitting.
    const rows = await this.db
      .select({
        id: pullRequestsTable.id,
        number: pullRequestsTable.number,
        taskId: pullRequestsTable.taskId,
        owner: pullRequestsTable.owner,
        repo: pullRequestsTable.repo,
        state: pullRequestsTable.state,
        reviewRequested: pullRequestsTable.reviewRequested,
        authored: pullRequestsTable.authored,
      })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId),
          eq(pullRequestsTable.state, 'open')
        )
      );

    for (const row of rows) {
      const authored = authoredSet.has(row.number);
      const reviewRequested = pendingSet.has(row.number);
      if (authored === row.authored && reviewRequested === row.reviewRequested) {
        continue;
      }
      await this.db
        .update(pullRequestsTable)
        .set({ authored, reviewRequested, updatedAt: new Date() })
        .where(eq(pullRequestsTable.id, row.id));
      // The flag UPDATE above doesn't touch `lastSummary`, so this reads the
      // current value. Fetched per changed row (usually 0/tick), not in bulk.
      const [summaryRow] = await this.db
        .select({ lastSummary: pullRequestsTable.lastSummary })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, row.id))
        .limit(1);
      emitPullRequestUpdated(workspaceId, {
        id: row.id,
        taskId: row.taskId,
        repositoryId,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        state: row.state,
        lastSummary: (summaryRow?.lastSummary as Record<string, unknown> | null) ?? {},
        reviewRequested,
        authored,
      });
    }
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

  /**
   * Open PR numbers we're already tracking in the DB for this repo. Used to
   * keep refreshing rows that have dropped out of the live search but remain
   * open on GitHub.
   */
  private async getTrackedOpenNumbers(
    workspaceId: string,
    repositoryId: string
  ): Promise<number[]> {
    const rows = await this.db
      .select({ number: pullRequestsTable.number })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId),
          eq(pullRequestsTable.state, 'open')
        )
      );
    return rows.map((r) => r.number);
  }

  private async filterStale(
    workspaceId: string,
    repositoryId: string,
    numbers: number[],
    untracked?: Set<number>
  ): Promise<number[]> {
    if (numbers.length === 0) return [];
    const rows = await this.db
      .select({
        id: pullRequestsTable.id,
        number: pullRequestsTable.number,
        lastPolledAt: pullRequestsTable.lastPolledAt,
        authored: pullRequestsTable.authored,
        reviewRequested: pullRequestsTable.reviewRequested,
      })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId)
        )
      );
    // Build (number → row) so we can ask prFocus whether each PR is
    // focused/in-cooldown and whether its cohort is the one being viewed.
    // The id matches the `pull_requests.id` we hand out in /focus.
    const cached = new Map<
      number,
      { id: string; lastPolledAt: Date; authored: boolean; reviewRequested: boolean }
    >();
    for (const row of rows) {
      if (numbers.includes(row.number)) {
        cached.set(row.number, {
          id: row.id,
          lastPolledAt: row.lastPolledAt,
          authored: row.authored,
          reviewRequested: row.reviewRequested,
        });
      }
    }
    const now = Date.now();
    return numbers.filter((number) => {
      const entry = cached.get(number);
      if (!entry) return true; // never seen; always stale
      // Per-PR TTL: focused = 30 s, active-cohort settled = 60 s, untracked
      // or inactive-cohort = 5 min, cooldown = effectively infinite. The poll
      // tick fires every 30 s so a focused PR can refetch the moment it ages.
      const ttl = ttlFor(workspaceId, entry.id, {
        cohortActive: isCohortActive(workspaceId, entry),
        untracked: untracked?.has(number) ?? false,
      });
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
      .select({
        number: pullRequestsTable.number,
        id: pullRequestsTable.id,
        taskId: pullRequestsTable.taskId,
        owner: pullRequestsTable.owner,
        repo: pullRequestsTable.repo,
        lastSummary: pullRequestsTable.lastSummary,
        mergeQueued: pullRequestsTable.mergeQueued,
      })
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
    let sweptQueued = false;
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
      // A PR that left `open` can't be merged by the queue — clear its queue
      // bookkeeping in the same write. Leaving the flags set once stalled the
      // whole (repo, base) group: the merged head kept its "#1" slot while
      // being invisible to the processor's open-only select.
      await this.db
        .update(pullRequestsTable)
        .set({ state: nextState, mergedAt, updatedAt: new Date(), ...QUEUE_RESET_COLUMNS })
        .where(eq(pullRequestsTable.id, row.id));
      if (row.mergeQueued) sweptQueued = true;
      // Tell the desktop the PR left "open" (merged/closed upstream, incl.
      // auto-merge) so the open-only GitHub list drops the row live, instead
      // of waiting for the user to open or refresh it.
      emitPullRequestUpdated(workspaceId, {
        id: row.id,
        taskId: row.taskId,
        repositoryId: repo.id,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        state: nextState,
        lastSummary: (row.lastSummary as Record<string, unknown> | null) ?? {},
        mergeQueued: false,
        mergeQueueState: null,
      });
    }
    // A queued PR left the group — reshuffle the survivors' "#N" badges now
    // rather than waiting for the next processor action or a manual refresh.
    if (sweptQueued) await broadcastMergeQueuePositions(workspaceId);
  }

  /**
   * Derive `reviewRequestVia` (was I asked directly, via a team, or both?)
   * from the summary's raw `reviewRequests` and the viewer's identity +
   * teams (both cached). Mutates the summary in place; no-op when there's no
   * request data. Cheap — login + teams are cache hits on the hot path.
   */
  private async annotateReviewRequest(workspaceId: string, summary: PRSummary): Promise<void> {
    const raw = summary.reviewRequests;
    if (!raw) return;
    const login = await this.resolveCurrentUser(workspaceId);
    const myTeams = await githubService.getViewerTeamSlugs(workspaceId);
    const direct = login
      ? raw.users.some((u) => u.toLowerCase() === login.toLowerCase())
      : false;
    const teams = raw.teams
      .filter((t) => myTeams.has(t.combinedSlug.toLowerCase()))
      .map((t) => t.combinedSlug);
    summary.reviewRequestVia = { direct, teams };
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
    if (!(await this.drainInFlightTick())) return;
    await this.poll();
  }

  /**
   * Wait for an in-flight tick to finish, bounded by {@link FORCE_POLL_DRAIN_MS}.
   * Returns false when the tick is still running past the deadline — under
   * GitHub throttling a tick can run for minutes, and an unbounded wait here
   * left `POST /repositories/poll` hanging until the client's 300s timeout
   * (observed in prod, June 2026). Skipping is safe: the tick that's blocking
   * us is itself refreshing every connected workspace, so the caller's
   * follow-up read still gets fresh rows.
   */
  private async drainInFlightTick(): Promise<boolean> {
    const deadline = Date.now() + FORCE_POLL_DRAIN_MS;
    while (this.pollGuard.active) {
      if (Date.now() >= deadline) {
        console.warn('PR monitor: forced poll skipped — a poll tick is still in flight');
        return false;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  }

  /**
   * Refresh just the given workspaces' PRs. Drains any in-flight full tick
   * first (and holds the same guard) so it can't race the background poll.
   */
  async forcePollWorkspaces(workspaceIds: string[]): Promise<void> {
    if (workspaceIds.length === 0) return;
    if (!(await this.drainInFlightTick())) return;
    if (!this.pollGuard.tryBegin()) return;
    try {
      for (const workspaceId of workspaceIds) {
        try {
          await this.pollWorkspace(workspaceId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.error(`PR monitor: workspace ${workspaceId.slice(0, 8)} forced poll failed:`, msg);
        }
      }
    } finally {
      this.pollGuard.end();
    }
  }

  /**
   * The user-facing "Refresh" entry point: polls only the caller's own
   * connected workspaces. A single user must not be able to fan a refresh out
   * across every tenant's repos (that's what the unscoped {@link forcePoll}
   * does, which is why it's background/test-only).
   */
  async forcePollForOwner(ownerId: string): Promise<void> {
    const connected = new Set(githubService.getConnectedWorkspaces());
    const owned = await this.db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.ownerId, ownerId));
    await this.forcePollWorkspaces(owned.map((r) => r.id).filter((id) => connected.has(id)));
  }

  // ---------- Active-CI fast loop ----------

  /**
   * Refetch only authored PRs with in-flight CI, GraphQL-only, on a tight
   * cadence. Skips Search entirely (the numbers come from the cache), so it
   * never touches the rate-limited Search budget.
   */
  private async fastPoll(): Promise<void> {
    if (!this.fastGuard.tryBegin()) return;
    const startedAt = Date.now();
    let count = 0;
    try {
      for (const workspaceId of githubService.getConnectedWorkspaces()) {
        count++;
        try {
          await this.fastPollWorkspace(workspaceId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.error(`PR fast-poll: workspace ${workspaceId.slice(0, 8)} failed:`, msg);
        }
      }
    } finally {
      this.fastGuard.end();
      debugBus.pollerTick('pr_monitor_fast_ci', {
        durationMs: Date.now() - startedAt,
        ok: true,
        summary: `pr_monitor_fast_ci tick — ${count} workspace${count === 1 ? '' : 's'}`,
      });
    }
  }

  private async fastPollWorkspace(workspaceId: string): Promise<void> {
    const rows = await this.db
      .select({
        id: pullRequestsTable.id,
        owner: pullRequestsTable.owner,
        repo: pullRequestsTable.repo,
        number: pullRequestsTable.number,
        repositoryId: pullRequestsTable.repositoryId,
        // Derive the only bit of `lastSummary` this loop needs — the in-flight
        // check count — server-side, so the ~2KB summary jsonb never ships for
        // every authored open PR on the 10s fast tick. Mirrors `inProgressChecks`.
        inProgressChecks: sql<number>`COALESCE((${pullRequestsTable.lastSummary} -> 'checks' ->> 'inProgress')::int, 0)`,
        authored: pullRequestsTable.authored,
        reviewRequested: pullRequestsTable.reviewRequested,
      })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.state, 'open'),
          eq(pullRequestsTable.authored, true)
        )
      );

    // Authored PRs with checks still running, whose cohort is the one being
    // viewed (CI matters on "My PRs", not while reviewing others'), skipping
    // any in post-refresh cooldown. Capped.
    const due = rows
      .filter(
        (r) =>
          r.inProgressChecks > 0 &&
          isCohortActive(workspaceId, r) &&
          !isInCooldown(workspaceId, r.id)
      )
      .slice(0, ACTIVE_CI_MAX_PER_WORKSPACE);
    if (due.length === 0) return;

    // Group by repo so each repo is one batched GraphQL round-trip.
    const byRepo = new Map<string, { owner: string; repo: string; repositoryId: string; numbers: number[] }>();
    for (const r of due) {
      const key = `${r.owner}/${r.repo}`;
      const g = byRepo.get(key) ?? { owner: r.owner, repo: r.repo, repositoryId: r.repositoryId, numbers: [] };
      g.numbers.push(r.number);
      byRepo.set(key, g);
    }

    for (const g of byRepo.values()) {
      try {
        const results = await batchPullRequestsByNumber({
          workspaceId,
          owner: g.owner,
          repo: g.repo,
          numbers: g.numbers,
        });
        for (const result of results) {
          if (!result.pr) continue;
          await this.annotateReviewRequest(workspaceId, result.pr);
          // No flag changes — relationship reconcile stays on the search
          // ticks; this loop only refreshes the summary (CI, mergeable).
          await upsertFromBatchResult({
            workspaceId,
            repositoryId: g.repositoryId,
            summary: result.pr,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.error(`PR fast-poll: ${g.owner}/${g.repo} failed:`, msg);
      }
    }
  }

  /** Test/admin entry point for the fast loop — see `forcePoll`. */
  async forceFastPoll(): Promise<void> {
    while (this.fastGuard.active) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.fastPoll();
  }

  /**
   * Refetch a single PR's summary now — the trigger the notifications poller
   * fires on activity. GraphQL-only, no relationship-flag changes (those stay
   * on the search ticks). No-op if the repo isn't watched in this workspace.
   */
  async refreshPr(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number
  ): Promise<void> {
    const watched = (await this.getWatchedRepos(workspaceId)).find(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.repo.toLowerCase() === repo.toLowerCase()
    );
    if (!watched) return;
    const results = await batchPullRequestsByNumber({
      workspaceId,
      owner: watched.owner,
      repo: watched.repo,
      numbers: [number],
    });
    for (const result of results) {
      if (!result.pr) continue;
      await this.annotateReviewRequest(workspaceId, result.pr);
      await upsertFromBatchResult({
        workspaceId,
        repositoryId: watched.id,
        summary: result.pr,
      });
    }
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

/**
 * Number of in-flight check runs on a cached PR summary (0 if unknown).
 * `fastPollWorkspace` now derives this in SQL (see its select) to avoid
 * shipping `lastSummary`; this stays as the canonical JS definition the
 * SQL must stay equivalent to (pinned by `prMonitorFastPollEgress.test.ts`).
 */
export function inProgressChecks(lastSummary: unknown): number {
  const checks = (lastSummary as { checks?: { inProgress?: number } } | null)?.checks;
  return checks?.inProgress ?? 0;
}

export const prMonitorService = new PRMonitorService();
