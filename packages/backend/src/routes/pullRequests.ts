import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { forceFetchAndUpsert } from '../services/prCache.js';
import { batchPullRequests, fetchPRReviewDetail } from '../services/githubGraphql.js';
import { githubService } from '../services/github.js';
import {
  setFocused,
  clearFocused,
  markRefreshed,
  setActiveView,
  type ActiveView,
} from '../services/prFocus.js';
import { handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { emitPullRequestUpdated } from '../services/websocket.js';
import { mergeQueueProcessor } from '../services/mergeQueueProcessor.js';
import {
  computeQueuePositions,
  broadcastMergeQueuePositions,
} from '../services/mergeQueueBroadcast.js';
import type { ApiResponse } from '@fastowl/shared';

/**
 * Routes for the PR/CI surface. Mostly read-only — the one write path is
 * merge (gated in the UI to mergeable PRs and behind an explicit
 * confirm). Review/comment composition still deep-links to github.com.
 *
 *   GET   /pull-requests                  list workspace PRs
 *   GET   /pull-requests/:id              full detail (always fresh GraphQL)
 *   GET   /pull-requests/:id/files        file-by-file diff (live REST)
 *   POST  /pull-requests/:id/refresh      force fetch + upsert
 *   POST  /pull-requests/:id/auto-keep-mergeable  toggle the watcher
 *   POST  /pull-requests/:id/merge-queue  add/remove from the merge queue
 *   POST  /pull-requests/:id/focus        mark focused (adaptive-poll TTL)
 *   POST  /pull-requests/:id/merge        merge the PR (merge|squash|rebase)
 */

export function pullRequestRoutes(): Router {
  const router = Router();

  // List PRs for a workspace. Filters: state ('open' | 'closed' |
  // 'merged' | 'all', default 'open'), repo (repository_id),
  // taskOnly (true → only PRs linked to a task), search (substring
  // match on title or owner/repo), relationship ('authored' |
  // 'review_requested' | 'all', default 'all').
  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();

    const stateFilter = (req.query.state as string | undefined) ?? 'open';
    const repoFilter = req.query.repo as string | undefined;
    const taskOnly = req.query.taskOnly === 'true';
    const search = (req.query.search as string | undefined)?.toLowerCase().trim();
    // 'authored' (PRs the user opened) | 'review_requested' (PRs
    // awaiting the user's review) | 'all' (default).
    const relationship = req.query.relationship as string | undefined;

    const conditions = [eq(pullRequestsTable.workspaceId, workspaceId)];
    if (stateFilter !== 'all') {
      conditions.push(eq(pullRequestsTable.state, stateFilter));
    }
    if (repoFilter) {
      conditions.push(eq(pullRequestsTable.repositoryId, repoFilter));
    }
    if (relationship === 'authored') {
      conditions.push(eq(pullRequestsTable.authored, true));
    } else if (relationship === 'review_requested') {
      // `reviewRequested` already means "awaiting my review" — the monitor
      // clears it once the user reviews the PR, so an approved PR is gone.
      conditions.push(eq(pullRequestsTable.reviewRequested, true));
    }

    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(and(...conditions))
      .orderBy(desc(pullRequestsTable.lastPolledAt));

    let filtered = rows;
    if (taskOnly) {
      filtered = filtered.filter((r) => r.taskId != null);
    }
    if (search) {
      filtered = filtered.filter((r) => {
        const title =
          ((r.lastSummary as { title?: string } | null)?.title ?? '').toLowerCase();
        const fullName = `${r.owner}/${r.repo}`.toLowerCase();
        return title.includes(search) || fullName.includes(search);
      });
    }

    // 1-based merge-queue position per (repo, base branch) group, FIFO by
    // `mergeQueuedAt`. Computed locally over the rows we already have.
    const queuePositionById = computeQueuePositions(filtered as PullRequestRow[]);

    res.json({
      success: true,
      data: filtered.map((r) =>
        rowToPublicShape(r, queuePositionById.get(r.id) ?? 0)
      ),
    } as ApiResponse<ReturnType<typeof rowToPublicShape>[]>);
  });

  // Single PR detail. Always returns the persisted row plus a fresh
  // recentReviews/recentReviewComments/recentComments fan-out via a
  // dedicated GraphQL fetch — the cache stores only the summary,
  // detail-view tabs need the recent* arrays + reviewBody for the
  // Reviews tab.
  router.get('/:id', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const summaryHead =
      ((row.lastSummary as { headBranch?: string } | null)?.headBranch) ?? null;
    if (!summaryHead) {
      return res.json({
        success: true,
        data: { row: rowToPublicShape(row), fresh: null },
      });
    }

    let fresh: Awaited<ReturnType<typeof batchPullRequests>>[number]['pr'] = null;
    try {
      const results = await batchPullRequests({
        workspaceId: row.workspaceId,
        owner: row.owner,
        repo: row.repo,
        branches: [summaryHead],
      });
      fresh = results[0]?.pr ?? null;
    } catch (err) {
      // Network blip, token revoked, etc — caller still gets the
      // cached row.
      console.warn(`[pull-requests] fresh detail fetch failed for ${row.id}:`, err);
    }

    // GraphQL only returns OPEN PRs. A null result on a row still marked
    // 'open' means it merged/closed upstream — reconcile so the row (and
    // its tab) stops claiming it's open.
    let outRow = row;
    if (!fresh && row.state === 'open') {
      const reconciled = await reconcileTerminalState(row);
      if (reconciled) outRow = reconciled;
    }

    res.json({
      success: true,
      data: { row: rowToPublicShape(outRow), fresh },
    });
  });

  // File-by-file diff for a PR. Returns each changed file's status,
  // per-file +/- stats, and the unified-diff `patch` so the desktop can
  // render it inline via the same PatchDiff viewer the task Files tab
  // uses — no more "view on GitHub" hand-off. This is a live REST hit
  // (not cached): the files list is only fetched when the user opens the
  // Files tab, so it's low-frequency.
  router.get('/:id/files', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    try {
      const files = await githubService.getPRFiles(
        row.workspaceId,
        row.owner,
        row.repo,
        row.number
      );
      res.json({ success: true, data: files });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // Full review/comment detail for the Reviews tab — every submitted
  // review (with body), every inline review thread (grouped, with diff
  // hunk + resolved state), and the top-level conversation comments.
  // Live GraphQL fetch, only when the user opens the tab.
  router.get('/:id/reviews', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    try {
      const detail = await fetchPRReviewDetail({
        workspaceId: row.workspaceId,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
      });
      res.json({ success: true, data: detail });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // Force a fresh fetch + upsert. Bypasses the cache TTL. Returns the
  // new persisted shape.
  router.post('/:id/refresh', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const result = await forceFetchAndUpsert({
      workspaceId: row.workspaceId,
      repositoryId: row.repositoryId,
      taskId: row.taskId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
    });
    if (!result) {
      // GraphQL returned nothing → the PR isn't open. Reconcile its
      // terminal state via REST so a manual refresh can recover a row
      // that's stuck (e.g. a merged PR still showing as closed/open).
      const reconciled = await reconcileTerminalState(row);
      if (reconciled) {
        return res.json({ success: true, data: rowToPublicShape(reconciled) });
      }
      return res
        .status(404)
        .json({ success: false, error: 'PR not found on GitHub or has no head branch in cache' });
    }
    // Cooldown: the next 5 s of poll-driven refetches skip this PR
    // so a manual refresh doesn't get stomped by a racing tick.
    markRefreshed(row.workspaceId, result.rowId);

    const fresh = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, result.rowId))
      .limit(1);
    res.json({ success: true, data: rowToPublicShape(fresh[0]) });
  });

  // Auto-keep-mergeable toggle. Body `{ enabled: boolean }`. When on, the
  // background watcher repeatedly fires a "take this PR to a clean, mergeable
  // state" cloud run whenever the PR has a blocker and nothing's already
  // working it — indefinitely, including conflicts that appear days later.
  router.post('/:id/auto-keep-mergeable', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const enabled = (req.body as { enabled?: boolean }).enabled === true;
    // Enabling: arm a fresh guard so the next watcher tick fires immediately if
    // the PR already needs work. Disabling: clear all watcher bookkeeping.
    const nextState = enabled ? { attempts: 0, accounted: true } : null;
    await db
      .update(pullRequestsTable)
      .set({
        autoKeepMergeable: enabled,
        autoMergeState: nextState,
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
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      autoKeepMergeable: enabled,
      autoMergeState: publicAutoMergeState(nextState),
    });

    res.json({ success: true, data: null } as ApiResponse<null>);
  });

  // Merge-queue toggle. Body `{ enabled: boolean, method?: 'merge'|'squash'|'rebase' }`.
  // When on, the PR joins the FastOwl merge queue: the background processor
  // merges it (per `method`, default squash) as soon as it's clean, serialized
  // per (repo, base branch). On conflict / behind / blocked it fires the same
  // cloud "fix every blocker" run the watcher uses, then merges. The PR drops
  // off the queue once merged.
  router.post('/:id/merge-queue', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const body = req.body as { enabled?: boolean; method?: string } | undefined;
    const enabled = body?.enabled === true;
    const method =
      body?.method === 'merge' || body?.method === 'rebase' || body?.method === 'squash'
        ? body.method
        : row.mergeMethod; // keep the existing method when omitted
    // Enabling: arm a fresh guard so the next processor tick acts immediately,
    // and preserve the queue place on a fast off/on toggle. Disabling: clear
    // all queue bookkeeping.
    const nextState = enabled ? { status: 'waiting' as const, attempts: 0, accounted: true } : null;
    await db
      .update(pullRequestsTable)
      .set({
        mergeQueued: enabled,
        mergeQueuedAt: enabled ? (row.mergeQueuedAt ?? new Date()) : null,
        mergeMethod: method,
        mergeQueueState: nextState,
        updatedAt: new Date(),
      })
      .where(eq(pullRequestsTable.id, row.id));

    // When disabling, the row is no longer in the queue so the group rebroadcast
    // below won't touch it — emit its cleared badge explicitly here.
    if (!enabled) {
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
    }
    // Recompute "#N" for the whole queue so the toggled PR gets its real
    // position and every sibling shifts to match — not just after a refresh.
    await broadcastMergeQueuePositions(row.workspaceId);

    // Kick a tick so an already-clean PR merges without waiting for the poll.
    if (enabled) void mergeQueueProcessor.runOnce();

    res.json({ success: true, data: null } as ApiResponse<null>);
  });

  // Focus signal. Body `{ focused: true }` (default) tightens this
  // PR's poll TTL to 30 s; `{ focused: false }` reverts to 60 s.
  // Idempotent — duplicate calls are no-ops.
  router.post('/:id/focus', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select({ workspaceId: pullRequestsTable.workspaceId })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const focused = (req.body as { focused?: boolean } | undefined)?.focused !== false;
    if (focused) {
      setFocused(row.workspaceId, req.params.id);
    } else {
      clearFocused(row.workspaceId, req.params.id);
    }
    res.status(204).send();
  });

  // Active-view signal. Body `{ workspaceId, view }` records which list the
  // desktop is showing ('mine' | 'review' | 'all' | 'none') so the poller can
  // hard-poll the cohort you're looking at and slack-poll the other one.
  // In-memory + idempotent, same spirit as /focus.
  const ALLOWED_VIEWS: ActiveView[] = ['mine', 'review', 'all', 'none'];
  router.post('/view', async (req, res) => {
    const body = req.body as { workspaceId?: string; view?: string } | undefined;
    const workspaceId = body?.workspaceId;
    const view = body?.view;
    if (!workspaceId || !view || !ALLOWED_VIEWS.includes(view as ActiveView)) {
      return res
        .status(400)
        .json({ success: false, error: 'workspaceId and a valid view are required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    setActiveView(workspaceId, view as ActiveView);
    res.status(204).send();
  });

  // Merge a PR. The only write path in this router — the desktop gates
  // the button to mergeable PRs and shows a confirm first, but we
  // re-validate nothing here beyond ownership: GitHub itself rejects the
  // merge (405) if the PR isn't actually mergeable, and we surface that
  // as a 400. On success we force a refetch so the row flips to `merged`
  // immediately instead of waiting for the next poll tick.
  router.post('/:id/merge', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const method = (req.body as { method?: string } | undefined)?.method;
    const mergeMethod =
      method === 'squash' || method === 'rebase' || method === 'merge'
        ? method
        : 'squash';

    try {
      const result = await githubService.mergePullRequest(
        row.workspaceId,
        row.owner,
        row.repo,
        row.number,
        { merge_method: mergeMethod }
      );
      // GitHub can return 200 with `merged: false` (it accepted the request
      // but didn't merge). Don't flip the row to merged or report success in
      // that case — surface its message so the UI can explain why.
      if (!result.merged) {
        return res.status(400).json({
          success: false,
          error: result.message || 'GitHub did not merge the pull request',
        });
      }
      // Mark the row merged directly. We can't rely on a GraphQL refetch
      // here — `batchPullRequests` filters to `states: [OPEN]`, so a
      // just-merged PR comes back empty and the row would stay stuck on
      // its last open state ("Ready"). The merge succeeded, so set it.
      await db
        .update(pullRequestsTable)
        .set({ state: 'merged', mergedAt: new Date(), updatedAt: new Date() })
        .where(eq(pullRequestsTable.id, row.id));
      res.json({ success: true, data: result } as ApiResponse<typeof result>);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Merge failed';
      res.status(400).json({ success: false, error: message });
    }
  });

  return router;
}

interface PullRequestRow {
  id: string;
  workspaceId: string;
  repositoryId: string;
  taskId: string | null;
  owner: string;
  repo: string;
  number: number;
  state: string;
  reviewRequested: boolean;
  authored: boolean;
  mergedAt: Date | null;
  lastPolledAt: Date;
  lastSummary: unknown;
  autoKeepMergeable: boolean;
  autoMergeState: unknown;
  mergeQueued: boolean;
  mergeQueuedAt: Date | null;
  mergeMethod: string;
  mergeQueueState: unknown;
  lastReviewId: string | null;
  lastReviewCommentId: string | null;
  lastCommentId: string | null;
  lastCheckDigest: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Reconcile a PR's lifecycle state against GitHub via REST. The GraphQL
 * batch query only returns OPEN PRs, so once a PR is merged/closed our
 * normal fetch paths can't tell merged from closed — and a row that was
 * mis-classified (e.g. a transient sweep failure marking a merged PR
 * "closed") never gets re-checked. This hits the authoritative per-PR
 * REST endpoint and corrects state + mergedAt. Returns the updated row,
 * or null if nothing changed / the lookup failed.
 */
async function reconcileTerminalState(
  row: PullRequestRow
): Promise<PullRequestRow | null> {
  let pr: Awaited<ReturnType<typeof githubService.getPullRequest>>;
  try {
    pr = await githubService.getPullRequest(row.workspaceId, row.owner, row.repo, row.number);
  } catch (err) {
    console.warn(`[pull-requests] terminal reconcile failed for ${row.id}:`, err);
    return null;
  }
  let nextState: 'open' | 'closed' | 'merged';
  let mergedAt: Date | null = null;
  if (pr.merged_at || pr.merged) {
    nextState = 'merged';
    mergedAt = pr.merged_at ? new Date(pr.merged_at) : new Date();
  } else if (pr.state === 'closed') {
    nextState = 'closed';
  } else {
    nextState = 'open';
  }
  if (nextState === row.state) return null;

  const db = getDbClient();
  // A PR that left 'open' can't be merged by the queue — drop it off so it
  // never blocks its (repo, base) group.
  const queueReset =
    nextState !== 'open' && row.mergeQueued
      ? { mergeQueued: false, mergeQueuedAt: null, mergeQueueState: null }
      : {};
  await db
    .update(pullRequestsTable)
    .set({ state: nextState, mergedAt, updatedAt: new Date(), ...queueReset })
    .where(eq(pullRequestsTable.id, row.id));
  const fresh = await db
    .select()
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, row.id))
    .limit(1);
  return (fresh[0] as PullRequestRow | undefined) ?? null;
}

/** The compact watcher state the desktop renders (toggle + badge). */
function publicAutoMergeState(
  raw: unknown
): { attempts: number; paused: boolean } | null {
  const s = raw as { attempts?: number; pausedAt?: string } | null;
  if (!s) return null;
  return { attempts: s.attempts ?? 0, paused: !!s.pausedAt };
}

/** The compact merge-queue state the desktop renders (toggle + badge). */
function publicMergeQueueState(
  raw: unknown,
  position: number
): {
  status: 'waiting' | 'fixing' | 'merging' | 'blocked';
  attempts: number;
  position: number;
} | null {
  const s = raw as
    | { status?: 'waiting' | 'fixing' | 'merging' | 'blocked'; attempts?: number }
    | null;
  if (!s) return null;
  return { status: s.status ?? 'waiting', attempts: s.attempts ?? 0, position };
}

function rowToPublicShape(row: PullRequestRow, queuePosition = 0) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    taskId: row.taskId,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    state: row.state,
    reviewRequested: row.reviewRequested,
    authored: row.authored,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    lastPolledAt: row.lastPolledAt.toISOString(),
    summary: row.lastSummary,
    autoKeepMergeable: row.autoKeepMergeable,
    autoMergeState: publicAutoMergeState(row.autoMergeState),
    mergeQueued: row.mergeQueued,
    mergeMethod: row.mergeMethod,
    mergeQueueState: publicMergeQueueState(row.mergeQueueState, queuePosition),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

