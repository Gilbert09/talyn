import { create } from 'zustand';
import type {
  CodeReviewPublic,
  MergeQueuePublic,
  PRRow,
  PRSummaryShape,
  PRState,
} from '../lib/api';
import { jsonEqual, mergeSummaryPatch } from '../lib/summaryPatch';

/**
 * Shared open-PR state, lifted out of the old single GitHub panel so the
 * Sidebar (live count badges) and the three pages — My PRs, Reviews, Merge
 * Queue — all read one set of rows kept current by a single
 * `pull_request:updated` subscription. `usePullRequestSync` owns the fetch +
 * WS wiring and writes here; components read + derive their filtered views.
 *
 * The list holds OPEN PRs only — merged/closed rows are dropped on the WS
 * echo, matching the old panel's open-only browse model.
 */

/** Payload shape of a `pull_request:updated` WS event. Relationship/watcher/
 *  queue fields only ride along when they changed, so they're optional. */
export interface PullRequestUpdatePayload {
  id: string;
  taskId: string | null;
  state: PRState;
  /** May be a *partial* summary (e.g. the incremental check-count path sends only
   *  `{ checks }`); it's merged into the held summary, not replaced. Absent
   *  means "summary unchanged" — the merge queue's position broadcast omits it. */
  lastSummary?: Partial<PRSummaryShape>;
  reviewRequested?: boolean;
  /** Only on the emit that STAMPED it — a plain `authored` flip omits it. */
  reviewRequestedFirstSeenAt?: string | null;
  /** The Reviews-tab hide. Only the hide route emits it, and `null` (an
   *  unhide) is a real value — see the merge below. */
  reviewHiddenAt?: string | null;
  authored?: boolean;
  watching?: boolean;
  autoKeepMergeable?: boolean;
  autoMergeState?: { attempts: number; paused: boolean } | null;
  mergeQueued?: boolean;
  /** The merge queue's payload. Null when the PR is not queued. */
  mergeQueue?: MergeQueuePublic | null;
  /**
   * The code review's payload. Null when the PR has never been reviewed, and
   * `null` is a REAL value here — a force-push clears the review. See the merge
   * below: absent preserves, null clears, and getting that round the wrong way
   * leaves a stale review pinned to a commit that no longer exists.
   */
  codeReview?: CodeReviewPublic | null;
}

interface PullRequestState {
  rows: PRRow[];
  loading: boolean;
  error: string | null;
  // null = connection not yet checked. Distinguishes "GitHub disconnected"
  // from "connected but no PRs" so the empty state isn't misleading.
  connected: boolean | null;
  // The viewer's GitHub login — labels "requested directly" rows on Reviews.
  viewerLogin: string | null;
  // Whether PostHog Code (cloud tasks) is configured — gates follow-up runs.
  posthogConnected: boolean;
  // True while the catch-up poll that follows a fresh GitHub connection runs.
  // That fetch asks GitHub rather than the cache, so it is the slow one — and
  // it is the one somebody is watching, having just authorized. It only
  // changes the loader's wording: without it the page shows a bare spinner and
  // then, for a workspace whose repos have never been polled, an empty list.
  initialSync: boolean;

  setRows: (rows: PRRow[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setConnected: (connected: boolean | null) => void;
  setViewerLogin: (login: string | null) => void;
  setPosthogConnected: (connected: boolean) => void;
  setInitialSync: (initialSync: boolean) => void;

  /**
   * Merge a `pull_request:updated` echo into `rows` in place. Returns true
   * when the payload is for an OPEN PR we don't yet hold, so the caller can
   * refetch the open list (we lack workspaceId/repositoryId to insert it,
   * and the backend orders by lastPolledAt).
   */
  applyPullRequestUpdate: (p: PullRequestUpdatePayload) => boolean;
  /**
   * The same merge for a batch of echoes, in arrival order, in ONE `set`. Rows
   * an echo did not change keep their object identity, and a batch that
   * changes nothing does not call `set` at all. Returns true when any payload
   * is an open PR we don't hold.
   */
  applyPullRequestUpdates: (payloads: PullRequestUpdatePayload[]) => boolean;

  /** Insert a row we already hold in full, or replace it if it's there.
   *  Used when the client MINTS a row rather than discovering it — watching a
   *  PR by URL returns the whole row, so re-listing would be wasted work. */
  upsertRow: (row: PRRow) => void;
  /** Optimistic single-row patch (merge-queue toggle, task linking). */
  patchRow: (id: string, updates: Partial<PRRow>) => void;
  /** Drop a row (optimistic merge, or it left the open set). */
  removeRow: (id: string) => void;
}

/** Every field `mergeRowUpdate` writes — the ones a no-op check must compare. */
const MERGED_ROW_FIELDS = [
  'state',
  'summary',
  'taskId',
  'reviewRequested',
  'reviewRequestedFirstSeenAt',
  'reviewHiddenAt',
  'authored',
  'watching',
  'autoKeepMergeable',
  'autoMergeState',
  'mergeQueued',
  'mergeQueue',
  'codeReview',
] as const satisfies readonly (keyof PRRow)[];

/**
 * Merge one `pull_request:updated` echo into a held row. Returns `row` itself
 * when the echo changes nothing, so the store can keep the row's identity and
 * a memoized table row does not re-render.
 */
function mergeRowUpdate(row: PRRow, p: PullRequestUpdatePayload): PRRow {
  const next: PRRow = {
    ...row,
    state: p.state,
    // Merge, don't replace: an incremental echo carries only the changed slice
    // (e.g. `{ checks }`), and full echoes carry every field so merging is a
    // no-op for them. Keeps title/mergeable/etc. when only counts changed.
    // A checks slice older than the one held is dropped (see mergeSummaryPatch).
    summary: mergeSummaryPatch(row.summary, p.lastSummary),
    // Preserve a known link if the echo omits it; adopt a new one when the
    // backend reports it (e.g. just-started fix task).
    taskId: p.taskId ?? row.taskId,
    // Relationship flags are only on the payload when the monitor re-bucketed
    // the row (e.g. it left Review after being reviewed); else keep ours.
    reviewRequested: p.reviewRequested ?? row.reviewRequested,
    // Same `??` rule and the same reason: only the transition emit carries
    // this, so every other echo must leave the stamp we already hold alone.
    reviewRequestedFirstSeenAt: p.reviewRequestedFirstSeenAt ?? row.reviewRequestedFirstSeenAt,
    // `undefined` means the echo says nothing about the hide; `null` means it
    // says the PR is visible again. `??` would swallow the unhide, so this
    // one tests for `undefined` explicitly.
    reviewHiddenAt: p.reviewHiddenAt !== undefined ? p.reviewHiddenAt : row.reviewHiddenAt,
    authored: p.authored ?? row.authored,
    // Same rule, and it matters more here: the poll's flag reconcile and every
    // prCache upsert emit this event WITHOUT `watching`, so a `||` (or a
    // bare assign) would drop a just-watched PR off My PRs on the next tick.
    // `??` keeps ours, and still honours the un-watch echo's explicit false.
    watching: p.watching ?? row.watching,
    // Watcher state only rides along when it changed; otherwise keep ours.
    autoKeepMergeable: p.autoKeepMergeable ?? row.autoKeepMergeable,
    autoMergeState: p.autoMergeState !== undefined ? p.autoMergeState : row.autoMergeState,
    // Merge-queue state only rides along when it changed; otherwise keep ours.
    mergeQueued: p.mergeQueued ?? row.mergeQueued,
    mergeQueue: p.mergeQueue !== undefined ? p.mergeQueue : row.mergeQueue,
    // EXPLICIT undefined, never `??`, and this is the single most likely bug in
    // the feature. `??` reads correctly and swallows the CLEAR: a force-push
    // emits `null` to say "those findings describe a commit that is gone", and
    // `??` would keep showing them. Same family as `reviewHiddenAt`,
    // `autoMergeState` and `mergeQueue` above — all four distinguish absent
    // from null because absent means "this emitter did not know" and null means
    // "there is none".
    codeReview: p.codeReview !== undefined ? p.codeReview : row.codeReview,
  };
  const changed = MERGED_ROW_FIELDS.some((k) => !jsonEqual(row[k], next[k]));
  return changed ? next : row;
}

export const usePullRequestStore = create<PullRequestState>((set, get) => ({
  rows: [],
  // Starts true so the pages show their loading state on first paint, before
  // usePullRequestSync's initial-fetch effect has even run (effects fire after
  // render — starting false would flash the empty state for a frame).
  loading: true,
  error: null,
  connected: null,
  viewerLogin: null,
  posthogConnected: false,
  initialSync: false,

  setRows: (rows) => set({ rows }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setConnected: (connected) => set({ connected }),
  setViewerLogin: (viewerLogin) => set({ viewerLogin }),
  setPosthogConnected: (posthogConnected) => set({ posthogConnected }),
  setInitialSync: (initialSync) => set({ initialSync }),

  applyPullRequestUpdate: (p) => get().applyPullRequestUpdates([p]),

  applyPullRequestUpdates: (payloads) => {
    const prev = get().rows;
    // First match wins, as `findIndex` did before batching.
    const indexById = new Map<string, number>();
    prev.forEach((r, i) => {
      if (!indexById.has(r.id)) indexById.set(r.id, i);
    });
    let next: PRRow[] | null = null;
    const removed = new Set<string>();
    let needsRefetch = false;
    // In arrival order: two echoes for one PR can each be a partial patch, so
    // the later one is applied on top of the earlier, never instead of it.
    for (const p of payloads) {
      const idx = indexById.get(p.id);
      if (idx === undefined || removed.has(p.id)) {
        // The list only holds open PRs, so a non-open echo for a row we don't
        // have is a no-op. A new *open* PR needs a refetch (we can't hand-insert
        // without workspaceId/repositoryId) — signal that to the caller.
        if (p.state === 'open') needsRefetch = true;
        continue;
      }
      // A row that left "open" (merged/closed upstream, incl. auto-merge) no
      // longer belongs in this open-only list — drop it.
      if (p.state !== 'open') {
        removed.add(p.id);
        continue;
      }
      const current = (next ?? prev)[idx];
      const merged = mergeRowUpdate(current, p);
      if (merged === current) continue;
      if (!next) next = prev.slice();
      next[idx] = merged;
    }
    // Nothing changed: skip the `set`, so no subscriber re-renders.
    if (!next && removed.size === 0) return needsRefetch;
    const rows = next ?? prev;
    set({ rows: removed.size > 0 ? rows.filter((r) => !removed.has(r.id)) : rows });
    return needsRefetch;
  },

  upsertRow: (row) =>
    set((state) => {
      const idx = state.rows.findIndex((r) => r.id === row.id);
      if (idx === -1) return { rows: [row, ...state.rows] };
      const rows = state.rows.slice();
      rows[idx] = row;
      return { rows };
    }),

  patchRow: (id, updates) =>
    set((state) => ({
      rows: state.rows.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    })),

  removeRow: (id) =>
    set((state) => ({ rows: state.rows.filter((r) => r.id !== id) })),
}));
