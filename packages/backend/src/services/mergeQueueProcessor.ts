import { and, eq, ne } from 'drizzle-orm';
import {
  prNeedsFollowup,
  mergeBlockerReason,
  buildMergeablePrompt,
  type PRMergeableSummary,
} from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { createCloudTask } from './taskCreate.js';
import { prMonitorService } from './prMonitor.js';
import { githubService } from './github.js';
import { emitPullRequestUpdated, emitMergeQueueBlocked } from './websocket.js';
import {
  broadcastMergeQueuePositions,
  QUEUE_RESET_COLUMNS,
} from './mergeQueueBroadcast.js';
import { debugBus } from './debugBus.js';
import { TickGuard } from './tickGuard.js';
import { ACTIVE_STATUSES, linkedTaskStatus, resolveCloudEnv } from './prCloudFix.js';

const POLL_INTERVAL_MS = 10_000;
/** Re-poll a queued PR if its cached summary is older than this. */
const FRESHNESS_MS = 90_000;
/** Stop auto-firing fix runs after this many consecutive un-mergeable runs. */
const MAX_ATTEMPTS = 3;

type MergeMethod = 'merge' | 'squash' | 'rebase';
type QueueStatus = 'waiting' | 'fixing' | 'merging' | 'blocked';

/**
 * What a processed PR means for the rest of its queue group this tick:
 * `hold` — the PR is being actively worked (merged, fixing, waiting on a run),
 * so it keeps the group's turn; `advance` — the PR can't make progress (gave
 * up as blocked, or left the queue), so the next queued PR gets a go now
 * instead of sitting behind it.
 */
type HeadVerdict = 'hold' | 'advance';

interface MergeQueueState {
  attempts: number;
  lastFixTaskId?: string;
  /** Whether `lastFixTaskId`'s terminal result has been folded into attempts. */
  accounted?: boolean;
  status: QueueStatus;
  lastError?: string;
  lastErrorAt?: string;
  /** Why the PR is blocked, captured at the transition into `blocked`. */
  blockReason?: string;
}

// Only the columns this processor touches — avoids `select()`-ing every PR
// column (and any large one added to the table later) on each 10s tick. The
// `Pick` makes the compiler enforce completeness: read a column not listed
// here and tsc fails, so the projection can't silently drift out of sync.
const QUEUE_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  taskId: pullRequestsTable.taskId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  lastPolledAt: pullRequestsTable.lastPolledAt,
  lastSummary: pullRequestsTable.lastSummary,
  mergeQueued: pullRequestsTable.mergeQueued,
  mergeQueueState: pullRequestsTable.mergeQueueState,
  mergeMethod: pullRequestsTable.mergeMethod,
} as const;

type PRRow = Pick<typeof pullRequestsTable.$inferSelect, keyof typeof QUEUE_COLUMNS>;

function readState(row: PRRow): MergeQueueState {
  const s = (row.mergeQueueState as MergeQueueState | null) ?? null;
  return {
    attempts: s?.attempts ?? 0,
    lastFixTaskId: s?.lastFixTaskId,
    accounted: s?.accounted ?? true,
    status: s?.status ?? 'waiting',
    lastError: s?.lastError,
    lastErrorAt: s?.lastErrorAt,
    blockReason: s?.blockReason,
  };
}

/** Compact queue state for the desktop (toggle + badge). `position` is 1-based. */
function publicState(s: MergeQueueState, position: number): {
  status: QueueStatus;
  attempts: number;
  position: number;
  reason?: string;
} {
  return {
    status: s.status,
    attempts: s.attempts,
    position,
    // The blocked badge's tooltip explains *why* it gave up.
    ...(s.status === 'blocked' && s.blockReason ? { reason: s.blockReason } : {}),
  };
}

/**
 * A short, human reason a queued PR is blocked — for the notification + badge.
 * Conflicts/changes/CI come from the summary; "behind the base" is read off
 * `mergeStateStatus`, which `mergeBlockerReason` doesn't see, so check it here.
 */
function blockerReason(row: PRRow, summary: PRMergeableSummary): string {
  if (prNeedsFollowup(summary)) return mergeBlockerReason(summary);
  if (needsUpdate(row)) return 'the branch is behind its base';
  return 'needs attention';
}

function baseBranchOf(row: PRRow): string {
  return (row.lastSummary as { baseBranch?: string } | null)?.baseBranch ?? '';
}

function mergeStateOf(row: PRRow): string {
  return (
    (row.lastSummary as { mergeStateStatus?: string } | null)?.mergeStateStatus ?? 'UNKNOWN'
  ).toUpperCase();
}

/**
 * Behind / blocked-by-out-of-date is a queue blocker that `prNeedsFollowup`
 * misses — it's exactly the state every sibling PR lands in after one merges to
 * the shared base. Funnel it into the same cloud fix run, which merges the base
 * branch in and brings the branch current.
 */
function needsUpdate(row: PRRow): boolean {
  const s = mergeStateOf(row);
  return s === 'BEHIND' || s === 'BLOCKED';
}

function queueBlocked(row: PRRow, summary: PRMergeableSummary): boolean {
  return prNeedsFollowup(summary) || needsUpdate(row);
}

/**
 * The head commit still has queued / in-progress checks reporting. GitHub
 * surfaces such a PR as `mergeStateStatus = BLOCKED` — the same status it uses
 * for a *failed* required check — so `needsUpdate`/`queueBlocked` can't tell
 * "CI hasn't finished" apart from "CI failed" on their own.
 */
function ciInFlight(summary: PRMergeableSummary): boolean {
  return (summary.checks?.inProgress ?? 0) > 0;
}

/**
 * A *settled* reason the PR can't merge — one a fix run should act on now, even
 * if other checks are still running: conflicts, changes requested, unresolved
 * threads, or a failed REQUIRED check (all caught by `prNeedsFollowup`), or
 * BEHIND the base. Deliberately excludes a bare `BLOCKED` state, which is what
 * GitHub reports while required checks are merely pending — that case must wait
 * for CI, not be treated as blocked.
 */
function hasSettledBlocker(row: PRRow, summary: PRMergeableSummary): boolean {
  return prNeedsFollowup(summary) || mergeStateOf(row) === 'BEHIND';
}

function normalizeMethod(raw: unknown): MergeMethod {
  return raw === 'merge' || raw === 'rebase' ? raw : 'squash';
}

/**
 * Merges the PRs in the FastOwl merge queue one-by-one, serialized per
 * (workspace, repo, base branch). Each tick:
 *
 *   1. Load every queued open PR, FIFO by `merge_queued_at`.
 *   2. Group by (workspace, repo, base) — only same-base merges collide.
 *   3. Walk each group from its HEAD (earliest queued), skipping past PRs that
 *      can't make progress (hard-blocked after MAX_ATTEMPTS, or no longer in
 *      the queue) until one takes an action — so a blocked PR never gates the
 *      PRs queued behind it. The first actionable PR consumes the group's turn:
 *      with the single-threaded `ticking` guard and the merge being a
 *      synchronous awaited REST call, two same-base PRs can never both merge in
 *      a tick — while distinct groups proceed independently.
 *
 * Per PR: refresh stale state, then merge if clean, or fire the shared
 * "take this PR to a clean, mergeable state" cloud run on conflict / behind /
 * blocked, wait for it (active-task guard), retry, and drop the PR off the
 * queue once merged — which promotes the next same-base PR to head.
 */
class MergeQueueProcessor {
  private interval: NodeJS.Timeout | null = null;
  // Wedge watchdog: one stalled await must never freeze the loop forever —
  // see TickGuard for the prod incidents that shaped this.
  private guard = new TickGuard('mergeQueueProcessor');

  init(): void {
    if (this.interval) return;
    debugBus.registerPoller(
      'merge_queue',
      POLL_INTERVAL_MS,
      'Merges queued PRs one-by-one, serialized per (workspace, repo, base branch) — merges the head when clean, fires a cloud fix run on conflict/behind/blocked, and skips past hard-blocked PRs so they never gate the rest of the queue.',
    );
    this.interval = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — run a single tick synchronously. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.guard.tryBegin()) return;
    const startedAt = Date.now();
    let headCount = 0;
    let tickError: string | undefined;
    let skipRecord = false;
    try {
      const db = getDbClient();

      // Self-heal: clear queue bookkeeping on rows that left `open` while
      // still flagged queued (a sweep/refresh path flipped the state without
      // the reset). Such rows are invisible to the open-only select below, so
      // their stale flags would otherwise live forever — and pollute the
      // position math anywhere that doesn't filter on state.
      const healed = await db
        .update(pullRequestsTable)
        .set({ ...QUEUE_RESET_COLUMNS, updatedAt: new Date() })
        .where(
          and(
            eq(pullRequestsTable.mergeQueued, true),
            ne(pullRequestsTable.state, 'open')
          )
        )
        .returning({ workspaceId: pullRequestsTable.workspaceId });
      for (const workspaceId of new Set(healed.map((r) => r.workspaceId))) {
        await broadcastMergeQueuePositions(workspaceId);
      }

      const rows = await db
        .select(QUEUE_COLUMNS)
        .from(pullRequestsTable)
        .where(
          and(
            eq(pullRequestsTable.mergeQueued, true),
            eq(pullRequestsTable.state, 'open')
          )
        )
        .orderBy(pullRequestsTable.mergeQueuedAt);

      // Group by (workspace, repo, base) — `rows` is already FIFO-ordered, so
      // each group's array is its queue order, head first.
      const groups = new Map<string, PRRow[]>();
      for (const row of rows) {
        const key = `${row.workspaceId}|${row.repositoryId}|${baseBranchOf(row)}`;
        const group = groups.get(key);
        if (group) group.push(row);
        else groups.set(key, [row]);
      }

      headCount = groups.size;
      // Distinct groups are independent — a slow GitHub round-trip for one
      // (workspace, repo, base) must not gate the others. Process groups
      // concurrently so the tick's wall-time is the slowest single group, not
      // the sum of all of them: serializing groups held the re-entrancy guard
      // for minutes while a multi-PR backlog drained, so every 10s tick in
      // between no-op'd on the guard and the queue looked frozen. Within a group
      // we stay serial — one same-base merge per tick.
      await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) {
        skipRecord = true;
        return;
      }
      tickError = msg;
      console.error('[mergeQueueProcessor] tick error:', err);
    } finally {
      this.guard.end();
      if (!skipRecord) {
        debugBus.pollerTick('merge_queue', {
          durationMs: Date.now() - startedAt,
          ok: !tickError,
          summary: tickError
            ? `merge_queue tick failed: ${tickError}`
            : `merge_queue tick — ${headCount} head${headCount === 1 ? '' : 's'}`,
          error: tickError,
        });
      }
    }
  }

  /**
   * Act on one queued PR. `position` is its 1-based slot within its queue
   * group (1 = head), echoed on the WS badge. Returns whether the group
   * should keep walking past this PR this tick (see `HeadVerdict`).
   */
  /**
   * Walk one group from its head, skipping past PRs that can't make progress
   * ('advance': hard-blocked, or gone from the queue) so a blocked head never
   * gates the PRs behind it. The first PR that takes an action ('hold': merge,
   * fix run, in-flight run) consumes the group's turn — one same-base merge per
   * tick. Never throws: a single PR's failure is logged and ends the group's turn.
   */
  private async processGroup(group: PRRow[]): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      const row = group[i];
      let verdict: HeadVerdict = 'hold';
      try {
        verdict = await this.processHead(row, i + 1);
      } catch (err) {
        // One PR failing must never abort the tick — retry next time.
        console.warn(
          `[mergeQueueProcessor] failed for PR ${row.owner}/${row.repo}#${row.number}:`,
          err instanceof Error ? err.message : err
        );
      }
      if (verdict === 'hold') break;
    }
  }

  private async processHead(initialRow: PRRow, position = 1): Promise<HeadVerdict> {
    const db = getDbClient();

    // 1. Freshness — refetch a stale summary so behind/conflict detection is
    //    current. A stale BEHIND head would otherwise be merge-attempted and
    //    bounce with `merged:false`.
    let row = initialRow;
    if (Date.now() - new Date(row.lastPolledAt).getTime() > FRESHNESS_MS) {
      await prMonitorService
        .refreshPr(row.workspaceId, row.owner, row.repo, row.number)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.warn(
            `[mergeQueueProcessor] freshness refetch failed for ${row.owner}/${row.repo}#${row.number}:`,
            msg
          );
        });
      const reread = await db
        .select(QUEUE_COLUMNS)
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, row.id))
        .limit(1);
      if (reread[0]) row = reread[0];
    }

    // The PR may have merged/closed underneath us. Drop it off the queue so it
    // never blocks the group, and let the next queued PR have this turn.
    if (row.state !== 'open') {
      if (row.mergeQueued) await this.dequeue(row);
      return 'advance';
    }
    if (!row.mergeQueued) return 'advance';

    const summary = row.lastSummary as PRMergeableSummary;
    const state = readState(row);

    // A persisted 'merging' on ENTRY means a previous attempt died between
    // GitHub accepting the merge and our DB write (wedged await, redeploy —
    // exactly the June 2026 incident: the PR merged on GitHub at 19:13 but the
    // row read open/merging for ever and the queue froze). Ask GitHub directly
    // before doing anything else; re-attempting the merge would just 405.
    if (state.status === 'merging' && (await this.verifyMerged(row))) {
      await this.recordMerged(row);
      return 'hold';
    }

    // 2. Active-run guard — never fire a NEW run while one is already working
    //    this PR. Check the queue's OWN last fix run by id, not just
    //    `row.taskId`: `row.taskId` is shared and gets reassigned by other flows
    //    (a manual task, the auto-keep-mergeable watcher), which would let the
    //    queue fire a duplicate while its own run is still in flight. Also honour
    //    any other run pointed to by `row.taskId` so we don't pile on.
    //
    //    Crucially, an in-flight run only HOLDS BACK a PR that's still blocked.
    //    A fix run can make the PR mergeable before its own status flips terminal
    //    (the commits land + checks go green while the task is still "running"),
    //    and there's no reason to sit on a ready PR waiting for that flip — so a
    //    clean PR falls through to the merge in step 5 regardless of the run.
    const ourFix = state.lastFixTaskId
      ? await linkedTaskStatus(state.lastFixTaskId)
      : null;
    const otherFix =
      row.taskId && row.taskId !== state.lastFixTaskId
        ? await linkedTaskStatus(row.taskId)
        : null;
    const runActive =
      (ourFix !== null && ACTIVE_STATUSES.has(ourFix)) ||
      (otherFix !== null && ACTIVE_STATUSES.has(otherFix));
    if (runActive && queueBlocked(row, summary)) {
      await this.ensureStatus(row, state, 'fixing', position);
      return 'hold';
    }

    // 2b. CI still settling — required checks are queued/in-progress on the head
    //     commit, which GitHub reports as mergeStateStatus=BLOCKED. Without this
    //     guard `needsUpdate` treats that BLOCKED exactly like a hard blocker:
    //     the queue fires a fix run and, after MAX_ATTEMPTS of CI-still-not-green,
    //     declares the PR blocked — all while CI had simply not finished. Hold
    //     the slot as 'waiting' and let the checks land, WITHOUT firing a run or
    //     counting an attempt. We only wait when pending CI is the *sole*
    //     obstacle: a settled blocker (conflict, behind, changes requested,
    //     unresolved threads, or a failed required check) still funnels into the
    //     fix path immediately below.
    if (ciInFlight(summary) && !hasSettledBlocker(row, summary)) {
      await this.ensureStatus(row, state, 'waiting', position);
      return 'hold';
    }

    // 3. Account the last fix run now that it's terminal. We only ever
    //    INCREMENT `attempts` here — never reset on a momentary non-blocked
    //    reading. The cached summary briefly reads mergeable/UNKNOWN right
    //    after a fix run pushes commits (GitHub recomputes mergeability async),
    //    and resetting on that transient lie is exactly what let the queue blow
    //    past MAX_ATTEMPTS and fire fix runs forever. A genuinely-fixed PR
    //    merges in step 5 and leaves the queue, so it never needs a reset.
    if (state.lastFixTaskId && !state.accounted && !runActive) {
      const wasBlocked = state.status === 'blocked';
      if (queueBlocked(row, summary)) {
        state.attempts += 1;
        if (state.attempts >= MAX_ATTEMPTS) state.status = 'blocked';
      }
      state.accounted = true;
      // Capture the reason at the transition so the badge + notification can
      // explain why the queue gave up.
      const justBlocked = !wasBlocked && state.status === 'blocked';
      if (justBlocked) state.blockReason = blockerReason(row, summary);
      await this.persist(row, state, position);
      // Fire-once notification: the queue exhausted its retries and now needs a
      // human. A dedicated event (not the idempotent pull_request:updated) so
      // the desktop notifies exactly once, never on reconnect/backfill replay.
      if (justBlocked) this.notifyBlocked(row, state);
    }

    // 4. Gave up after MAX_ATTEMPTS — wait for a human. We do NOT auto-reset
    //    `attempts` on a momentary clean reading (same transient-UNKNOWN trap as
    //    step 3). A genuinely-clean blocked PR falls through to the merge in
    //    step 5 and leaves the queue; a still-blocked one waits here until the
    //    user re-toggles the queue (the route resets the state) — and hands its
    //    turn to the next queued PR so it doesn't gate the group meanwhile.
    if (state.status === 'blocked' && queueBlocked(row, summary)) {
      return 'advance';
    }

    // 5. Clean path — mergeable AND up-to-date → merge it.
    if (!queueBlocked(row, summary)) {
      // Last-moment re-check: a force-released wedged tick can resume here
      // minutes later, after the PR merged or the user dequeued it. Never
      // merge off a stale snapshot.
      const current = await db
        .select({
          state: pullRequestsTable.state,
          mergeQueued: pullRequestsTable.mergeQueued,
        })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, row.id))
        .limit(1);
      if (!current[0] || current[0].state !== 'open' || !current[0].mergeQueued) return 'hold';
      state.status = 'merging';
      await this.persist(row, state, position);
      try {
        const result = await githubService.mergePullRequest(
          row.workspaceId,
          row.owner,
          row.repo,
          row.number,
          { merge_method: normalizeMethod(row.mergeMethod) }
        );
        if (!result.merged) {
          // GitHub accepted the request but didn't merge (e.g. it lost a race
          // and is now behind). Our cached summary is stale — refetch now so
          // the BEHIND/conflict state surfaces immediately and the next tick
          // funnels into the fix path, instead of re-attempting the merge
          // against the same stale summary until FRESHNESS_MS elapses.
          if (await this.verifyMerged(row)) {
            await this.recordMerged(row);
            return 'hold';
          }
          state.status = 'waiting';
          state.lastError = result.message || 'GitHub did not merge the pull request';
          state.lastErrorAt = new Date().toISOString();
          await this.persist(row, state, position);
          await this.refreshAfterFailedMerge(row);
          return 'hold';
        }
        await this.recordMerged(row);
      } catch (err) {
        // The merge was rejected. First disambiguate "already merged" (a lost
        // response on a merge that landed, a redeploy mid-merge, or an external
        // merge — GitHub 405s all of them) from a genuine blocker: the former
        // is a SUCCESS, and without this check the queue re-attempts a doomed
        // merge every tick while the row never leaves the head slot.
        if (await this.verifyMerged(row)) {
          await this.recordMerged(row);
          return 'hold';
        }
        // A real rejection (e.g. 405 "Pull Request has merge conflicts") means
        // our cached mergeability was stale. Record the error, then refetch the
        // PR immediately so the real conflicting/behind state hits the cache +
        // UI now instead of after FRESHNESS_MS — the next tick then funnels the
        // now-blocked PR into the cloud fix run. Don't dequeue.
        state.status = 'waiting';
        state.lastError = err instanceof Error ? err.message : 'Merge failed';
        state.lastErrorAt = new Date().toISOString();
        await this.persist(row, state, position);
        await this.refreshAfterFailedMerge(row);
      }
      return 'hold';
    }

    // 6. Blocked path — conflict / changes / failing CI / unresolved threads /
    //    BEHIND / BLOCKED. Funnel all of these into the SAME cloud fix run (it
    //    merges the base in, curing both conflicts and BEHIND in one run).

    // Hard cap — the absolute guard against firing past the retry budget, even
    // if a transient clean reading + failed merge briefly downgraded `status`
    // to 'waiting'. `attempts` only ever increments in step 3 (which already
    // notified at the cap), so just re-settle the badge to 'blocked' silently —
    // and hand the turn to the next queued PR.
    if (state.attempts >= MAX_ATTEMPTS) {
      await this.ensureStatus(row, state, 'blocked', position);
      return 'advance';
    }

    const resolved = await resolveCloudEnv(row.workspaceId);
    if (!resolved) {
      // No connected cloud provider — can't dispatch. Keep waiting; the
      // desktop badge surfaces this. (The PRs behind it can't dispatch either —
      // same workspace — so there's nothing to advance to.)
      await this.ensureStatus(row, state, 'waiting', position);
      return 'hold';
    }
    const { envId, provider } = resolved;

    const ref = `${row.owner}/${row.repo}#${row.number}`;
    const prTitle = (row.lastSummary as { title?: string } | null)?.title ?? '';
    const created = await createCloudTask({
      workspaceId: row.workspaceId,
      type: 'pr_response',
      title: `Get ${ref} mergeable (merge queue)`,
      description: `Merge queue: take ${ref} ("${prTitle}") to a clean, mergeable, up-to-date state.`,
      prompt: buildMergeablePrompt({
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        summary,
        provider,
      }),
      repositoryId: row.repositoryId,
      assignedEnvironmentId: envId,
      pullRequestId: row.id,
    });

    state.lastFixTaskId = created.id;
    state.accounted = false;
    state.status = 'fixing';
    await this.persist(row, state, position);
    return 'hold';
  }

  /**
   * Ask GitHub (REST — `merged_at` is the canonical signal, and the endpoint
   * works on merged PRs where the open-only GraphQL search can't see them)
   * whether the PR is in fact merged. Best-effort: any failure reads as "not
   * merged" and the caller falls back to its normal error handling.
   */
  private async verifyMerged(row: PRRow): Promise<boolean> {
    try {
      const pr = await githubService.getPullRequest(
        row.workspaceId,
        row.owner,
        row.repo,
        row.number
      );
      return Boolean(pr.merged_at || pr.merged);
    } catch {
      return false;
    }
  }

  /**
   * The single success path: flip the row terminal (the merge route can't
   * GraphQL-refetch a merged PR either), drop it off the queue, and reshuffle
   * the survivors' "#N" badges. The next same-base PR becomes head on the next
   * tick automatically.
   */
  private async recordMerged(row: PRRow): Promise<void> {
    const db = getDbClient();
    await db
      .update(pullRequestsTable)
      .set({
        state: 'merged',
        mergedAt: new Date(),
        ...QUEUE_RESET_COLUMNS,
        updatedAt: new Date(),
      })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: 'merged',
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: false,
      mergeQueueState: null,
    });
    await broadcastMergeQueuePositions(row.workspaceId);
  }

  /**
   * Force-refetch a PR right after a failed merge attempt. The merge API is
   * the freshest possible mergeability signal — if it rejected us, the cached
   * summary that said "mergeable" is stale. Refetching upserts the real state
   * (CONFLICTING/BEHIND) and emits `pull_request:updated`, so the UI updates
   * immediately and the next tick's `queueBlocked` check funnels the PR into
   * the cloud fix run rather than re-attempting a doomed merge for ~90s.
   * Best-effort: a refetch failure just falls back to the freshness timer.
   */
  private async refreshAfterFailedMerge(row: PRRow): Promise<void> {
    await prMonitorService
      .refreshPr(row.workspaceId, row.owner, row.repo, row.number)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn(
          `[mergeQueueProcessor] post-merge-failure refetch failed for ${row.owner}/${row.repo}#${row.number}:`,
          msg
        );
      });
  }

  /**
   * Emit the one-time `merge_queue:blocked` signal the desktop turns into an
   * OS notification + in-app toast. Best-effort: the persisted state + badge
   * already reflect the block, so a missed broadcast just costs the ping.
   */
  private notifyBlocked(row: PRRow, state: MergeQueueState): void {
    const summary = row.lastSummary as { title?: string; url?: string } | null;
    emitMergeQueueBlocked(row.workspaceId, {
      pullRequestId: row.id,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      title: summary?.title ?? '',
      url: summary?.url ?? '',
      reason: state.blockReason ?? 'needs attention',
      attempts: state.attempts,
    });
  }

  /** Persist `status` only if it changed, emitting a WS echo when it does. */
  private async ensureStatus(
    row: PRRow,
    state: MergeQueueState,
    status: QueueStatus,
    position = 1
  ): Promise<void> {
    if (state.status === status) return;
    state.status = status;
    await this.persist(row, state, position);
  }

  /** Drop a no-longer-open PR off the queue. */
  private async dequeue(row: PRRow): Promise<void> {
    const db = getDbClient();
    await db
      .update(pullRequestsTable)
      .set({ ...QUEUE_RESET_COLUMNS, updatedAt: new Date() })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: false,
      mergeQueueState: null,
    });
    // Dropping out of the queue shifts the survivors' positions — rebroadcast.
    await broadcastMergeQueuePositions(row.workspaceId);
  }

  private async persist(row: PRRow, state: MergeQueueState, position = 1): Promise<void> {
    const db = getDbClient();
    await db
      .update(pullRequestsTable)
      .set({ mergeQueueState: state, updatedAt: new Date() })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: row.mergeQueued,
      // The PR's 1-based slot within its queue group — the head is 1, but the
      // processor can act deeper in when blocked PRs are skipped over.
      mergeQueueState: publicState(state, position),
    });
  }
}

export const mergeQueueProcessor = new MergeQueueProcessor();
