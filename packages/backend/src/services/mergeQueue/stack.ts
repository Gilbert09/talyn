// Merge stack: "which PR owns the branch this entry is targeting?"
//
// A stack is a chain of PRs where each one's base branch is the previous one's
// head branch. The queue's group key is (repositoryId, baseBranch), so every
// member of a stack is a group of one and nothing orders them. This resolver
// is what R4b consults to park a child behind its parent and to retarget it
// once the parent lands.
//
// The edge is DERIVED, never persisted. A parent_pull_request_id column would
// be the same class of unmaintained denormalization that let base_branch rot:
// a user retargets a PR, a parent is opened after the child was enqueued, a
// branch is renamed — and the stored edge is silently wrong. Deriving it costs
// one query per group walk, because the group key IS the base branch: every
// entry in a walk shares it.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { prBlocksMerge, type PRMergeableSummary } from '@talyn/shared';
import { getDbClient, type Database } from '../../db/client.js';
import {
  pullRequests as pullRequestsTable,
  mergeQueueEntries,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { TERMINAL_STATUSES } from './store.js';
import type { EntryStatus } from './types.js';

type Db = Database;

/**
 * Hard bound on the climb. A stack this deep is a mistake, not a workflow, and
 * the bound is what stops a base/head cycle the visited-set somehow missed
 * from spinning the walk.
 */
const MAX_STACK_DEPTH = 16;

export interface StackParent {
  pullRequestId: string;
  number: number;
  /** The parent's head branch — equals the child's base branch (the join key). */
  headBranch: string;
  /** The parent's OWN base. This is where the child retargets to once it merges. */
  baseBranch: string;
  state: 'open' | 'closed' | 'merged';
  /** The parent's active queue entry status, or null when it isn't queued. */
  entryStatus: EntryStatus | null;
  /**
   * The branch the whole stack lands on — the base of the bottom-most
   * ancestor. Stable across every retarget (all members converge on it), which
   * is what lets the UI group a draining stack without its key churning.
   */
  targetBase: string;
  /** 1 = immediate parent. Display only. */
  depth: number;
  /** The ancestry revisits a PR — a base/head cycle. Deadlock guard. */
  cycle: boolean;
}

/** Just the fields the climb needs. Never ships the last_summary blob. */
interface PrBranchRow {
  id: string;
  number: number;
  state: string;
  headBranch: string | null;
  baseBranch: string | null;
}

async function prsByHeadBranch(
  db: Db,
  repositoryId: string,
  workspaceId: string,
  branches: string[]
): Promise<PrBranchRow[]> {
  if (branches.length === 0) return [];
  return db
    .select({
      id: pullRequestsTable.id,
      number: pullRequestsTable.number,
      state: pullRequestsTable.state,
      headBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headBranch'`,
      baseBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'baseBranch'`,
    })
    .from(pullRequestsTable)
    .where(
      and(
        eq(pullRequestsTable.repositoryId, repositoryId),
        // Scoped by workspace as well as repo: the same repo can be tracked by
        // two workspaces, and a branch name must never link across them.
        eq(pullRequestsTable.workspaceId, workspaceId),
        inArray(sql`${pullRequestsTable.lastSummary} ->> 'headBranch'`, branches),
        // A PR that targets the branch it is FROM is not a stack link. The
        // model is child.base == parent.head, so a parent with head == base
        // makes the "parent" target the same branch as the child — a sibling
        // at best, never something to wait for. In practice these are
        // master → master PRs (a mistaken open, or a fork sync), and
        // PostHog/posthog#69000 was exactly that: closed, head `master`, base
        // `master`. It made the resolver name it the owner of `master`, so
        // every PR in the repo read as stacked on an abandoned parent and
        // blocked with "retarget this PR, or reopen and merge that one"
        // (2026-08-18).
        ne(
          sql`${pullRequestsTable.lastSummary} ->> 'headBranch'`,
          sql`${pullRequestsTable.lastSummary} ->> 'baseBranch'`
        )
      )
    );
}

/**
 * The repo's default branch, which can never be a stack parent's HEAD.
 *
 * The rule the self-targeting filter above cannot express: a PR opened FROM
 * the trunk onto some other branch (a release branch, a fork sync) has
 * head == the trunk, and would make every PR targeting the trunk read as
 * stacked on it. A stack is topic branches; the trunk is where stacks land,
 * never a link inside one.
 */
async function defaultBranchOf(db: Db, repositoryId: string): Promise<string | null> {
  const rows = await db
    .select({ defaultBranch: repositoriesTable.defaultBranch })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, repositoryId))
    .limit(1);
  return rows[0]?.defaultBranch ?? null;
}

/** Active queue-entry status per PR id, for the PRs we resolved as parents. */
async function activeEntryStatuses(
  db: Db,
  prIds: string[]
): Promise<Map<string, EntryStatus>> {
  if (prIds.length === 0) return new Map();
  const rows = await db
    .select({
      pullRequestId: mergeQueueEntries.pullRequestId,
      status: mergeQueueEntries.status,
    })
    .from(mergeQueueEntries)
    .where(inArray(mergeQueueEntries.pullRequestId, prIds));
  const out = new Map<string, EntryStatus>();
  for (const r of rows) {
    if (TERMINAL_STATUSES.includes(r.status as EntryStatus)) continue;
    out.set(r.pullRequestId, r.status as EntryStatus);
  }
  return out;
}

function normalizeState(state: string): StackParent['state'] {
  return state === 'merged' || state === 'closed' ? state : 'open';
}

/**
 * Resolve the stack parent of each given base branch, keyed by that branch.
 * An absent key means no PR owns the branch — the entry is a stack root, or it
 * has already been retargeted onto a real base.
 *
 * The first hop is deliberately STATE-AGNOSTIC: a *merged* parent is exactly
 * what triggers the retarget, so seeding on open PRs only would break the
 * feature outright. Every hop above it follows OPEN parents only, matching
 * `linkStack` in @talyn/shared — a landed ancestor has left the stack.
 */
export async function resolveStackParents(
  repositoryId: string,
  workspaceId: string,
  baseBranches: string[],
  db: Db = getDbClient()
): Promise<Map<string, StackParent>> {
  const trunk = await defaultBranchOf(db, repositoryId);
  // Nothing is stacked ON the trunk — drop it before it can seed a chain.
  const seeds = [...new Set(baseBranches.filter((b) => b && b !== trunk))];
  if (seeds.length === 0) return new Map();

  const hop1 = await prsByHeadBranch(db, repositoryId, workspaceId, seeds);
  // First writer wins on a duplicate head branch, preferring an open PR — the
  // same tie-break linkStack makes, so the UI and the queue agree.
  const parentByBranch = new Map<string, PrBranchRow>();
  for (const row of hop1) {
    if (!row.headBranch) continue;
    const existing = parentByBranch.get(row.headBranch);
    if (!existing) parentByBranch.set(row.headBranch, row);
    else if (existing.state !== 'open' && row.state === 'open') {
      parentByBranch.set(row.headBranch, row);
    }
  }
  if (parentByBranch.size === 0) return new Map();

  // Climb to the bottom of each chain to learn where the stack actually lands.
  // Cached across seeds: sibling entries in one group share most of the chain.
  const openParentCache = new Map<string, PrBranchRow | null>();
  const lookupOpenParent = async (branch: string): Promise<PrBranchRow | null> => {
    if (branch === trunk) return null; // the chain ends at the trunk
    if (openParentCache.has(branch)) return openParentCache.get(branch)!;
    const found = (await prsByHeadBranch(db, repositoryId, workspaceId, [branch])).find(
      (r) => r.state === 'open'
    );
    openParentCache.set(branch, found ?? null);
    return found ?? null;
  };

  const statuses = await activeEntryStatuses(
    db,
    [...parentByBranch.values()].map((p) => p.id)
  );

  const out = new Map<string, StackParent>();
  for (const [branch, parent] of parentByBranch) {
    const seen = new Set<string>([parent.id]);
    let cursor = parent;
    let depth = 1;
    let cycle = false;
    // A merged/closed parent is the bottom as far as this child is concerned:
    // it has left the stack, and its own base is where the child retargets to.
    while (cursor.state === 'open' && depth < MAX_STACK_DEPTH) {
      const next = cursor.baseBranch ? await lookupOpenParent(cursor.baseBranch) : null;
      if (!next) break;
      if (seen.has(next.id)) {
        cycle = true;
        break;
      }
      seen.add(next.id);
      cursor = next;
      depth += 1;
    }
    out.set(branch, {
      pullRequestId: parent.id,
      number: parent.number,
      headBranch: parent.headBranch ?? branch,
      baseBranch: parent.baseBranch ?? '',
      state: normalizeState(parent.state),
      entryStatus: statuses.get(parent.id) ?? null,
      targetBase: cursor.baseBranch ?? '',
      depth,
      cycle,
    });
  }
  return out;
}

// ───────────────────────── GitHub native stacks ─────────────────────────
//
// Everything above derives the stack from branch shapes, which is what the UI
// indents by and what the serial drain runs on. Everything below reads
// GitHub's OWN stack object off the cached summary instead.
//
// The distinction decides whether a stack may be batched. trunk.io lands a
// whole stack in one CI round only when GITHUB says it is a stack ("GitHub
// considers this PR to be a part of a stack" is trunk's own wording), so a
// chain of PRs that merely target each other's branches is not eligible — it
// takes the serial drain, exactly as before. Deriving batch eligibility from
// branch shapes would submit stacks the provider will refuse, and the refusal
// costs a wasted submission on every rung.

/** One rung, as the batch planner sees it. Never ships the summary blob. */
export interface StackChainMember {
  pullRequestId: string;
  number: number;
  /** 1-based from the BOTTOM: 1 is the rung closest to the landing branch. */
  position: number;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  /** Non-terminal queue entry status, or null when this rung isn't queued. */
  entryStatus: EntryStatus | null;
  /** True when this rung currently holds a live submission to the provider. */
  submitted: boolean;
  /** Nothing about this rung individually blocks a merge. */
  ready: boolean;
}

export interface NativeStackChain {
  stackId: string;
  /** The branch the whole stack lands on (GitHub's `stack.baseRefName`). */
  targetBase: string;
  /** Open rungs only, ordered bottom-first. */
  members: StackChainMember[];
}

/**
 * The batch plan for ONE entry: what its role is in its stack's submission.
 *
 * Computed once per stack per group walk and handed to `decide`, which never
 * does I/O and must not walk a chain of its own.
 */
export interface StackBatchPlan {
  targetBase: string;
  /**
   * The rung to hand to the provider — the TOP open rung, because the provider
   * lands the rung it is given plus everything beneath it. Null when the stack
   * is not ready to be submitted yet (some rung is draft, conflicted, has
   * changes requested, or is not in the queue), in which case every rung
   * remediates and none submits.
   */
  submitNumber: number | null;
  /** Whether the entry being decided IS that rung. */
  isSubmitRung: boolean;
  /**
   * Set when ANOTHER rung is already holding a live submission that covers this
   * one. The provider ejects the whole batch when anything pushes to any
   * member, so a covered rung is as untouchable as the submitted one.
   */
  coveredBy: number | null;
  /** Open rungs the submission would land, including the submitted one. */
  size: number;
}

/**
 * Is this rung individually mergeable enough to be part of a submission?
 *
 * Exported and pure because the SQL projection below reproduces the summary
 * fields it reads, and this is the canonical definition that projection must
 * match (the pinning discipline in CLAUDE.md's egress rules).
 *
 * Deliberately says nothing about CI or reviews. The provider waits for branch
 * protection itself — trunk's own words are "it will be added to the merge
 * queue once all branch protection rules pass" — so holding the submission
 * back until every rung is green would add a full test cycle to exactly the
 * workflow this feature exists to speed up. What IS checked is the set of
 * things the provider will never resolve on its own and a fix run must:
 * conflicts, requested changes, red required checks, and drafts.
 */
export function stackRungReady(m: {
  state: string;
  draft: boolean;
  summary: Pick<PRMergeableSummary, 'blockingReason' | 'mergeable' | 'reviewDecision'>;
}): boolean {
  if (m.state !== 'open') return false;
  if (m.draft) return false;
  return !prBlocksMerge(m.summary as PRMergeableSummary);
}

/** Scalars the planner needs, pulled out of the summary jsonb IN SQL. */
interface StackMemberRow {
  id: string;
  number: number;
  state: string;
  position: number | null;
  draft: boolean | null;
  blockingReason: string | null;
  mergeable: string | null;
  reviewDecision: string | null;
}

/**
 * Every PR in one GitHub stack, with its queue entry, scoped to the workspace
 * and repository that asked.
 *
 * One query, and it never selects `last_summary` — the four fields the planner
 * reads are extracted server-side, the same shape `prMonitor.fastPollWorkspace`
 * uses to avoid shipping the blob on a poll loop.
 */
export async function resolveNativeStackChain(
  repositoryId: string,
  workspaceId: string,
  stackId: string,
  targetBase: string,
  db: Db = getDbClient()
): Promise<NativeStackChain | null> {
  const rows: StackMemberRow[] = await db
    .select({
      id: pullRequestsTable.id,
      number: pullRequestsTable.number,
      state: pullRequestsTable.state,
      position: sql<
        number | null
      >`(${pullRequestsTable.lastSummary} -> 'stack' ->> 'position')::int`,
      draft: sql<boolean | null>`(${pullRequestsTable.lastSummary} ->> 'draft')::boolean`,
      blockingReason: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'blockingReason'`,
      mergeable: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'mergeable'`,
      reviewDecision: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'reviewDecision'`,
    })
    .from(pullRequestsTable)
    .where(
      and(
        eq(pullRequestsTable.repositoryId, repositoryId),
        // Workspace-scoped like the derived resolver: the same repo tracked by
        // two workspaces must never link a stack across them.
        eq(pullRequestsTable.workspaceId, workspaceId),
        eq(sql`${pullRequestsTable.lastSummary} -> 'stack' ->> 'id'`, stackId)
      )
    );

  const open = rows.filter((r) => r.state === 'open' && typeof r.position === 'number');
  if (open.length === 0) return null;

  const entries = await db
    .select({
      pullRequestId: mergeQueueEntries.pullRequestId,
      status: mergeQueueEntries.status,
      externalSubmitVia: mergeQueueEntries.externalSubmitVia,
    })
    .from(mergeQueueEntries)
    .where(
      inArray(
        mergeQueueEntries.pullRequestId,
        open.map((r) => r.id)
      )
    );
  const entryByPr = new Map<string, { status: EntryStatus; submitted: boolean }>();
  for (const e of entries) {
    if (TERMINAL_STATUSES.includes(e.status as EntryStatus)) continue;
    entryByPr.set(e.pullRequestId, {
      status: e.status as EntryStatus,
      submitted: e.status === 'awaiting_external' && e.externalSubmitVia !== null,
    });
  }

  const members: StackChainMember[] = open
    .map((r) => {
      const entry = entryByPr.get(r.id) ?? null;
      return {
        pullRequestId: r.id,
        number: r.number,
        position: r.position!,
        state: 'open' as const,
        draft: r.draft === true,
        entryStatus: entry?.status ?? null,
        submitted: entry?.submitted ?? false,
        ready: stackRungReady({
          state: r.state,
          draft: r.draft === true,
          summary: {
            blockingReason: (r.blockingReason ?? 'unknown') as PRMergeableSummary['blockingReason'],
            mergeable: (r.mergeable ?? 'UNKNOWN') as PRMergeableSummary['mergeable'],
            reviewDecision: r.reviewDecision as PRMergeableSummary['reviewDecision'],
          },
        }),
      };
    })
    .sort((a, b) => a.position - b.position);

  return { stackId, targetBase, members };
}

/**
 * Turn a resolved chain into the per-entry plan, or null when this stack must
 * take the serial drain after all.
 *
 * The submission goes to the TOP open rung and only when every open rung is
 * both queued and individually ready — the provider tests the rungs as one
 * unit, so submitting with a conflicted rung four deep buys a failed batch and
 * a bisection to rediscover which rung was at fault, which is precisely the
 * cost Session 88 exists to avoid.
 *
 * "Every rung must be QUEUED" is the other half, and it is a promise rather
 * than a limitation: the submission lands rungs whether or not Talyn is
 * tracking them, so submitting a stack whose bottom rung the user never
 * enqueued would merge a PR they did not ask to merge. The stack enqueue
 * endpoint always takes the ancestors, so the ordinary path satisfies this.
 */
export function planStackBatch(
  chain: NativeStackChain,
  pullRequestId: string
): StackBatchPlan | null {
  const members = chain.members;
  if (members.length < 2) return null; // a stack of one is just a PR
  const self = members.find((m) => m.pullRequestId === pullRequestId);
  if (!self) return null;

  // Every rung from the bottom up must be visible, or the submission lands one
  // that is not. Positions are 1-based from the base branch, so a set that does
  // not read 1, 2, 3 … is missing a rung BELOW the top — a PR in this stack
  // that this workspace does not track, or whose summary predates the stack
  // fields. The provider would merge it along with the rest, which is precisely
  // the "never land a PR the user did not enqueue" promise below. A gap above
  // the top rung is harmless by contrast: it simply is not part of this
  // submission. Falling back to the serial drain is the safe answer either way.
  const contiguousFromBase = members.every((m, i) => m.position === i + 1);
  if (!contiguousFromBase) return null;

  const top = members[members.length - 1]!;
  const live = members.find((m) => m.submitted) ?? null;
  const everyRungQueued = members.every((m) => m.entryStatus !== null);
  const everyRungReady = members.every((m) => m.ready);

  return {
    targetBase: chain.targetBase,
    submitNumber: everyRungQueued && everyRungReady ? top.number : null,
    isSubmitRung: top.pullRequestId === pullRequestId,
    // A rung is covered by SOMEONE ELSE'S live submission. The submitted rung
    // itself is never "covered" — it tracks the provider through R5b, which is
    // the rule that knows what to do when the batch is ejected.
    coveredBy: live && live.pullRequestId !== pullRequestId ? live.number : null,
    size: members.length,
  };
}
