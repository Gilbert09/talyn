import type { RankingExperimentTrace } from './reviewRankingModel.js';
// Review priority — the ordering behind the Reviews tab's "Priority" sort.
//
// This is the ONE definition of "which of these PRs should I read next". The
// desktop and the web app are deliberate forks of each other, so a scorer
// written in a panel would be written twice and drift — the same argument
// `prFilters.ts` makes for its matcher, with higher stakes: two filters
// disagreeing shows a different SET, which somebody notices; two rankers
// disagreeing shows a different ORDER, which nobody does.
//
// # The shape, and why it is not one number
//
//   sortKey(pr) = ( gateRank , relevance + stateAdjust , -createdAt , id )
//
// A single additive score fails on a case that happens daily: forty small
// nudges float a draft PR, or one an agent is actively pushing commits to,
// above a PR whose author is waiting on nothing but your approval. The gate is
// a hard partition that no amount of point-scoring can cross. Within a gate the
// points do the fine ordering, and there the additive form is right — it is
// what makes a single term nameable, which is what the reason chip renders.
//
// # Where the weights come from
//
// Everything here is a hand-set constant today. The per-user model
// (`reviewRank.ts`) replaces the `relevance` term's constants with fitted ones
// and changes nothing else — not the gate, not `stateAdjust`, not the chip
// vocabulary. That is deliberate: the function's SHAPE is fixed, and learning
// only moves where five numbers come from.
//
// # What is deliberately NOT learned
//
// Every term in `gateRank` and `stateAdjust` reads live state — checks,
// conflicts, threads, drafts, an agent mid-run. None of it can ever be learned,
// because GitHub does not retain historical PR state: a merged PR reads green,
// mergeable and approved by definition, so training on it would teach "green
// checks cause reviews" from an artefact of merging. See `reviewRank.ts`.

// Imports only from `reviewRank.ts`, never from `index.ts` — that barrel
// re-exports this module, so reaching back through it would make a cycle. The
// caller supplies `isTaskActive` for the same reason: only the panel holds the
// tasks store. See PRPriorityContext.
import {
  REVIEW_RANK_DIM,
  applyReviewRank,
  effectiveReviewRankWeights,
  reviewRankContributions,
  reviewRankFeatures,
  standardize,
  type ReviewRankFeature,
  type ReviewRankProfile,
  type ReviewRankFeatureStats,
} from './reviewRank.js';

export const PR_PRIORITY_SCORER_VERSION = 'priority-2';

export interface PRPriorityRankInputs {
  features: number[];
  weights: number[];
  stats: ReviewRankFeatureStats | null;
}

export interface PRPriorityTrace {
  schemaVersion: 1;
  scorerVersion: string;
  source: 'server' | 'client';
  modelVersion: string | null;
  scoredAt: number;
  pooledScore?: number;
  target: PRPriorityTarget;
  taskActive: boolean;
  rankInputs: (Omit<PRPriorityRankInputs, 'features'> & { features: (number | null)[] }) | null;
}

/**
 * The hard partition. Higher sorts first, and no point total crosses it.
 *
 * Ordering only — these are never rendered as group headers. The Reviews tab
 * stays one flat list; the gate is what stops the fine-grained points from
 * producing an order a person would call wrong.
 */
export type PRPriorityGate =
  /** Somebody else is waiting on this landing, not just its author. */
  | 'blocking_others'
  /** The working set. Everything that is simply a PR you could review. */
  | 'actionable'
  /** The ball is with the author — reviewing now duplicates work. */
  | 'waiting_on_author'
  /** Reviewing now would be wasted: it is a draft, or it is mid-change. */
  | 'not_ready';

/** Sort rank of each gate. Higher first. */
export const PR_PRIORITY_GATE_RANK: Record<PRPriorityGate, number> = {
  blocking_others: 3,
  actionable: 2,
  waiting_on_author: 1,
  not_ready: 0,
};

/**
 * Every reason a PR can be moved up or down, and therefore every phrase the
 * reason chip can show.
 *
 * Exhaustive by construction: {@link PR_PRIORITY_REASON_LABEL} is a total
 * `Record` over this union, so adding a member without a phrase is a compile
 * error rather than a blank chip in the product. Same discipline as
 * `fixBlockedMessage` in `prMergeable.ts`.
 */
export type PRPriorityReason =
  // Gate reasons — why this PR is in the band it is in.
  | 'unblocks_stack'
  | 'in_merge_queue'
  | 'auto_merge_armed'
  | 'merge_conflicts'
  | 'checks_failed'
  | 'changes_requested'
  | 'draft'
  | 'agent_running'
  // State adjustments — the fine ordering within a band.
  | 'checks_green'
  | 'checks_running'
  | 'last_approval'
  | 'direct_request'
  | 'human_threads'
  | 'bot_threads'
  | 'bot_author'
  | 'size'
  | 're_review'
  | 'your_threads'
  | 'waited'
  // The learned term. One reason per feature, so the chip can name WHICH part
  // of a personal model moved the row — "ranked high" with no why is the
  // failure PRioritizer's user study died of.
  | 'known_author'
  | 'reviews_you'
  | 'known_files'
  | 'your_repo'
  | 'their_team'
  | 'shared_model'
  | 'quick_for_you';

/**
 * The chip phrase for each reason. Present tense, no trailing punctuation,
 * short enough to sit in a table cell beside the requester chip.
 *
 * Some carry a count or a duration, so a few are functions of the term's
 * `detail` — see {@link describePRPriorityReason}.
 */
export const PR_PRIORITY_REASON_LABEL: Record<PRPriorityReason, string> = {
  unblocks_stack: 'Unblocks others',
  in_merge_queue: 'In merge queue',
  auto_merge_armed: 'Auto-merge armed',
  merge_conflicts: 'Conflicts',
  checks_failed: 'Checks failing',
  changes_requested: 'Changes requested',
  draft: 'Draft',
  agent_running: 'Agent running',
  checks_green: 'All checks green',
  checks_running: 'Checks running',
  last_approval: 'Last approval',
  direct_request: 'Asked directly',
  human_threads: 'Author replying',
  bot_threads: 'Bot comments open',
  bot_author: 'Bot author',
  size: 'Quick',
  re_review: 'Re-review',
  your_threads: 'Your comments open',
  waited: 'Waited',
  shared_model: 'Suggested for review',
  known_author: 'You review them often',
  reviews_you: 'They review your PRs',
  known_files: 'You know these files',
  your_repo: 'Your repo',
  their_team: 'You review for this team',
  quick_for_you: 'Quick for you',
};

/** One contribution to a PR's placement, with what to call it. */
export interface PRPriorityTerm {
  reason: PRPriorityReason;
  /**
   * Signed points added to the within-gate score. **Zero for a gate marker**,
   * which is not a scoring miss: the gate has already done that term's work by
   * moving the PR to another band, and adding points on top would double-count
   * it against PRs in the same band.
   */
  points: number;
  /**
   * True when this term is why the row is in its gate, rather than a nudge
   * within one. Carried so the chip can explain a suppressed PR ("Draft") even
   * though nothing about it scored.
   */
  gateMarker?: true;
  /**
   * Extra the phrase needs — a count for `unblocks_stack`, a humanised
   * duration for `waited`. Absent when the bare phrase says everything.
   */
  detail?: string;
}

/** What {@link scorePRForReview} decides about one row. */
export interface PRPriorityVerdict {
  experiment?: RankingExperimentTrace;
  trace?: PRPriorityTrace;
  gate: PRPriorityGate;
  /**
   * The within-gate total. Compared ONLY against rows in the same gate — a
   * higher score never promotes a PR past the band the gate put it in.
   */
  score: number;
  /**
   * Every term that applied, ordered by descending absolute points. Gate
   * markers score 0 and therefore sort to the end. This is what the row
   * tooltip renders in full.
   */
  terms: PRPriorityTerm[];
  /**
   * What to put on the chip: the largest positive term, else the gate marker,
   * else the largest negative one.
   *
   * The fallbacks matter more than the primary case. A draft or a conflicted PR
   * has nothing positive to say about itself, and a blank cell on a row that
   * sank to the bottom is exactly the unexplained ordering that PRioritizer's
   * user study died of.
   */
  topReason: PRPriorityTerm | null;
}

/**
 * The subset of a PR row the scorer reads. Both the client `PRRow` and the
 * backend row shape are structural supersets.
 *
 * Every summary field is optional on purpose. A row cached before any of this
 * shipped must score without throwing and land in `actionable` — neither
 * promoted on evidence it does not have, nor buried for the same reason. That
 * is the discipline `rowToSummary` already applies to the unresolved-thread
 * split, which it leaves `undefined` rather than defaulting to zero.
 */
export interface PRPriorityTarget {
  id: string;
  owner?: string;
  repo?: string;
  taskId?: string | null;
  mergeQueued?: boolean;
  createdAt?: string;
  summary: {
    draft?: boolean;
    author?: string;
    createdAt?: string;
    mergeable?: string;
    blockingReason?: string;
    reviewDecision?: string | null;
    effectiveReviewDecision?: string | null;
    checks?: { total: number; passed: number; failed: number; inProgress: number; skipped: number };
    unresolvedHumanReviewThreads?: number;
    unresolvedBotReviewThreads?: number;
    unresolvedThreadsOpenedByViewer?: number;
    /**
     * Real diff size. Absent means UNKNOWN — never treat it as an empty diff,
     * which is the smallest thing this function can see.
     */
    additions?: number;
    deletions?: number;
    viewerLatestReview?: { state: string; submittedAt: string | null } | null;
    reviewRequestVia?: { direct: boolean; teams: string[] } | null;
    autoMergeBy?: string | null;
    /** Whether a MACHINE opened this PR. Absent = unknown, never "human". */
    prAuthorIsBot?: boolean;
    /** Top-level directories the PR touches, for path familiarity. */
    topDirs?: string[];
    stack?: { size: number; position: number } | null;
  };
  /**
   * When this PR first appeared in the viewer's review-requested cohort.
   *
   * The honest basis for "how long have I been sitting on this" — a PR opened
   * three weeks ago that you were added to yesterday has waited a day, not
   * three weeks. Absent until the column exists (and on rows that predate it),
   * in which case the age term falls back to when the PR was OPENED, which
   * over-states the wait rather than under-stating it.
   */
  reviewRequestedFirstSeenAt?: string | null;
}

/** Everything the scorer needs that is not on the row. */
export interface PRPriorityContext {
  /**
   * One instant for the whole pass.
   *
   * MUST be pinned by the caller and shared across every row in a sort.
   * `Array.prototype.sort` requires a consistent comparator, and a clock that
   * advances mid-sort makes one non-transitive — V8 then produces a scrambled
   * array with no error at all.
   */
  now: number;
  /**
   * Whether the row's linked task is still running. Returns false for an
   * unknown id, because a task we cannot see is not evidence of one in flight.
   */
  isTaskActive?: (taskId: string) => boolean;
  /**
   * The viewer's learned ranking profile, or null.
   *
   * Null is a first-class state, not a degraded one: a cold user is ranked by
   * the deterministic terms alone, which is a complete and useful ordering. The
   * model reorders WITHIN a gate; it can never promote a draft or bury a PR
   * that is blocking someone.
   */
  profile?: ReviewRankProfile | null;
  /** Exact numeric inputs for replay. Null explicitly disables the learned term. */
  rankInputs?: PRPriorityRankInputs | null;
  pooledScore?: number;
  captureTrace?: { source: 'server' | 'client'; modelVersion?: string };
}

function rankingInputs(row: PRPriorityTarget, ctx: PRPriorityContext): PRPriorityRankInputs | null {
  if (ctx.rankInputs !== undefined) return ctx.rankInputs;
  if (!ctx.profile) return null;
  const s = row.summary ?? {};
  return {
    features: reviewRankFeatures({
      author: s.author,
      repoFullName: row.owner && row.repo ? `${row.owner}/${row.repo}` : undefined,
      dirs: s.topDirs,
      teams: s.reviewRequestVia?.teams,
      additions: s.additions,
      deletions: s.deletions,
    }, ctx.profile),
    weights: effectiveReviewRankWeights(ctx.profile.model),
    stats: ctx.profile.featureStats ?? null,
  };
}

function scoringTrace(
  row: PRPriorityTarget,
  ctx: PRPriorityContext,
  taskActive: boolean,
  rankInputs: PRPriorityRankInputs | null,
): PRPriorityTrace {
  const s = row.summary ?? {};
  // Copy only inputs the scorer reads. Names, paths, and PR text stay out of the trace.
  const target: PRPriorityTarget = {
    id: row.id,
    taskId: taskActive ? 'active' : null,
    mergeQueued: row.mergeQueued,
    createdAt: row.createdAt,
    reviewRequestedFirstSeenAt: row.reviewRequestedFirstSeenAt,
    summary: {
      draft: s.draft,
      createdAt: s.createdAt,
      mergeable: s.mergeable,
      blockingReason: s.blockingReason,
      reviewDecision: s.reviewDecision,
      effectiveReviewDecision: s.effectiveReviewDecision,
      checks: s.checks,
      unresolvedHumanReviewThreads: s.unresolvedHumanReviewThreads,
      unresolvedBotReviewThreads: s.unresolvedBotReviewThreads,
      unresolvedThreadsOpenedByViewer: s.unresolvedThreadsOpenedByViewer,
      additions: s.additions,
      deletions: s.deletions,
      viewerLatestReview: s.viewerLatestReview,
      reviewRequestVia: s.reviewRequestVia ? { direct: s.reviewRequestVia.direct, teams: [] } : null,
      autoMergeBy: s.autoMergeBy ? 'armed' : null,
      prAuthorIsBot: s.prAuthorIsBot ?? /\[bot\]$/i.test(s.author ?? ''),
      stack: s.stack,
    },
  };
  return JSON.parse(JSON.stringify({
    schemaVersion: 1,
    scorerVersion: PR_PRIORITY_SCORER_VERSION,
    source: ctx.captureTrace!.source,
    modelVersion: ctx.captureTrace!.modelVersion ?? null,
    scoredAt: ctx.now,
    pooledScore: ctx.pooledScore,
    target,
    taskActive,
    rankInputs,
  })) as PRPriorityTrace;
}

export function replayPRPriorityTrace(trace: PRPriorityTrace): PRPriorityVerdict {
  if (trace.schemaVersion !== 1 || ![PR_PRIORITY_SCORER_VERSION, 'priority-1'].includes(trace.scorerVersion) ||
      !Number.isFinite(trace.scoredAt)) {
    throw new Error('Unsupported scoring trace');
  }
  if (trace.pooledScore !== undefined && (!Number.isFinite(trace.pooledScore) || trace.scorerVersion === 'priority-1')) {
    throw new Error('Invalid shared score');
  }
  const inputs = trace.rankInputs;
  // Production skips the learned term when stored statistics have an older dimension.
  if (inputs && (inputs.features.length !== REVIEW_RANK_DIM || inputs.weights.length !== REVIEW_RANK_DIM ||
      inputs.features.some((value) => value !== null && !Number.isFinite(value)) ||
      inputs.weights.some((value) => !Number.isFinite(value)) ||
      (inputs.stats && (inputs.stats.mean.length !== inputs.stats.sd.length ||
        [...inputs.stats.mean, ...inputs.stats.sd].some((value) => !Number.isFinite(value)) ||
        inputs.stats.sd.some((value) => value < 0))))) {
    throw new Error('Invalid scoring inputs');
  }
  return scorePRForReview(trace.target, {
    now: trace.scoredAt,
    pooledScore: trace.pooledScore,
    isTaskActive: () => trace.taskActive,
    // JSON stores unknown features as null. Standardization maps NaN to the mean.
    rankInputs: inputs ? { ...inputs, features: inputs.features.map((value) => value ?? NaN) } : null,
  });
}

/** Points, in one place, so the weights can be read without reading the logic. */
export const PR_PRIORITY_WEIGHTS = {
  checksGreen: 8,
  checksRunning: -4,
  lastApproval: 10,
  directRequest: 8,
  humanThreads: -6,
  botThreads: -3,
  /**
   * A machine opened this PR.
   *
   * Heavier than the other state adjustments on purpose: a dependency bump or
   * an agent-authored fix is real work, but it is almost never the thing a
   * person should read FIRST, and these arrive in bulk. Still short of a gate —
   * a bot PR that is blocking a stack should still surface.
   */
  botAuthor: -16,
  /** Per PR stacked above this one, capped by {@link unblocksStackCap}. */
  unblocksStack: 4,
  unblocksStackCap: 12,
  /** A re-review is work you have already started. */
  reReview: 6,
  /** Threads YOU opened that are still unresolved — you asked, they answered. */
  yourThreads: 5,
  /**
   * How far the LEARNED term can move a PR, in points.
   *
   * The clamp is the safety property, and the NUMBER is chosen against the age
   * ramp rather than picked for feel. The model learns whether you RESPOND, not
   * what you should have read, so left unbounded it entrenches: the person
   * whose PRs you have never got to sinks further, so you never get to them,
   * which confirms the model. Age is the escape hatch — it is deterministic and
   * rises with nothing but time.
   *
   * For that escape hatch to actually work the cap must sit BELOW the age
   * ramp's maximum ({@link agePoints} tops out at 16). At 12 a PR that has
   * waited its full ramp outranks one the model likes as much as it possibly
   * can, so nothing can be buried indefinitely by affinity alone. Raising this
   * above 16 would quietly remove the only thing stopping that.
   *
   * It is also well under any single gate, so the model reorders within a
   * readiness band and can never promote a draft or bury a PR blocking others.
   */
  learnedCap: 12,
} as const;

/** The reasons that come from the learned model rather than a rule. */
const LEARNED_REASONS = new Set<PRPriorityReason>([
  'known_author',
  'reviews_you',
  'known_files',
  'your_repo',
  'their_team',
  'quick_for_you',
]);

/** Which reason names each learned feature's contribution. */
const LEARNED_REASON: Record<ReviewRankFeature, PRPriorityReason> = {
  authorAffinity: 'known_author',
  reciprocity: 'reviews_you',
  pathFamiliarity: 'known_files',
  repoAffinity: 'your_repo',
  teamAffinity: 'their_team',
  logSize: 'quick_for_you',
};

/**
 * Points for a diff of `lines` changed.
 *
 * Bands rather than a curve, so the chip can name one ("Quick") and so the
 * thresholds are arguable. The numbers are LinearB's published ones, which are
 * the only widely-cited empirical thresholds in this space: under 100 lines is
 * small, over 400 is large, over 800 is where they flag real risk. Google's
 * median change is 24 lines, for scale.
 *
 * Deliberately no penalty below the large threshold — a big PR is not less
 * worth reviewing, it is just a worse thing to start on a Friday afternoon.
 */
export function sizePoints(lines: number | undefined): number {
  // Unknown is NOT small. A row cached before `additions` shipped must not be
  // rewarded for a diff nobody has measured.
  if (lines === undefined || !Number.isFinite(lines)) return 0;
  if (lines <= 100) return 8;
  if (lines <= 400) return 3;
  if (lines <= 800) return 0;
  return -6;
}

/**
 * The age ramp, in points.
 *
 * Rises to a cap at five days and then DECAYS. The decay is the deliberate
 * part: unbounded age turns the list into a graveyard sorted by neglect, with
 * the single most-abandoned request permanently on top. A review nobody has
 * given in three weeks is usually dead rather than urgent, and the ramp should
 * say so. 24 hours carries the biggest single step because that is the norm
 * Gerrit's attention set encodes — respond within a day, or hand it back.
 */
export function agePoints(hours: number): number {
  if (!Number.isFinite(hours) || hours < 4) return 0;
  if (hours < 12) return 4;
  if (hours < 48) return 10;
  if (hours < 120) return 14;
  if (hours < 336) return 16;
  return 6;
}

/** "3d", "16h", "45m" — the `waited` chip's detail. */
export function humaniseWait(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0m';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The chip text for one term, folding in its `detail` where it has one. */
export function describePRPriorityReason(term: PRPriorityTerm): string {
  const base = PR_PRIORITY_REASON_LABEL[term.reason];
  return term.detail ? `${base} ${term.detail}` : base;
}

/** Parse an ISO timestamp to epoch ms, or null when it is missing or junk. */
function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Score one review-requested PR.
 *
 * Pure: the same row and the same `now` always give the same verdict. Call it
 * ONCE per row into a `Map`, never from inside a comparator — see
 * {@link PRPriorityContext.now}.
 */
export function scorePRForReview(
  row: PRPriorityTarget,
  ctx: PRPriorityContext,
): PRPriorityVerdict {
  const s = row.summary ?? {};
  const terms: PRPriorityTerm[] = [];

  const push = (reason: PRPriorityReason, points: number, detail?: string) => {
    if (points !== 0) terms.push({ reason, points, detail });
  };
  /** Record WHY the row landed in its gate. Scores nothing — see PRPriorityTerm. */
  const pushGate = (reason: PRPriorityReason, detail?: string) => {
    terms.push({ reason, points: 0, gateMarker: true, detail });
  };

  const decision = s.effectiveReviewDecision ?? s.reviewDecision ?? null;

  // ---- gate: not_ready -----------------------------------------------------
  // Reviewing either of these wastes the review. The agent rule is the one
  // Talyn can make and GitHub cannot: we know a cloud run is pushing commits to
  // this PR right now, so whatever you read is about to change underneath you.
  const agentRunning =
    !!row.taskId && !!ctx.isTaskActive && ctx.isTaskActive(row.taskId);
  const isDraft = s.draft === true;

  // ---- gate: blocking_others ----------------------------------------------
  // Somebody other than the author is waiting on this landing.
  const descendants =
    s.stack && s.stack.size > 1 && s.stack.position === 1 ? s.stack.size - 1 : 0;
  const autoMergeArmed = !!s.autoMergeBy && decision === 'REVIEW_REQUIRED';
  const queued = row.mergeQueued === true;

  // ---- gate: waiting_on_author --------------------------------------------
  const conflicts = s.mergeable === 'CONFLICTING';
  const checksFailed = s.blockingReason === 'checks_failed';
  const changesRequested = decision === 'CHANGES_REQUESTED';

  let gate: PRPriorityGate;
  if (isDraft || agentRunning) {
    gate = 'not_ready';
    // Agent-running is named in preference to draft: it is the more surprising
    // of the two, and the one a person may want to act on by waiting.
    if (agentRunning) pushGate('agent_running');
    else pushGate('draft');
  } else if (conflicts || checksFailed || changesRequested) {
    gate = 'waiting_on_author';
    // One marker, most-specific first — three chips' worth of bad news on one
    // row tells a reviewer nothing they can act on.
    if (conflicts) pushGate('merge_conflicts');
    else if (changesRequested) pushGate('changes_requested');
    else pushGate('checks_failed');
  } else if (descendants > 0 || queued || autoMergeArmed) {
    gate = 'blocking_others';
    // Unlike the other gates this one DOES score, because its members differ
    // in how much they are blocking: a PR with four rungs stacked on it is
    // more urgent than one with a single sibling.
    if (descendants > 0) {
      push(
        'unblocks_stack',
        Math.min(
          descendants * PR_PRIORITY_WEIGHTS.unblocksStack,
          PR_PRIORITY_WEIGHTS.unblocksStackCap,
        ),
        String(descendants),
      );
    }
    if (autoMergeArmed) pushGate('auto_merge_armed');
    else if (queued) pushGate('in_merge_queue');
  } else {
    gate = 'actionable';
  }

  // ---- stateAdjust ---------------------------------------------------------
  // Deliberately small. The gate already expresses "blocked"; these terms are
  // the fine ordering inside one, and they must not be able to imply a band
  // the gate did not put the PR in.

  const checks = s.checks;
  if (checks && checks.total > 0) {
    if (checks.failed === 0 && checks.inProgress === 0) {
      push('checks_green', PR_PRIORITY_WEIGHTS.checksGreen);
    } else if (checks.inProgress > 0) {
      // Not a blocker, just a reason to wait: whatever you review now may need
      // reviewing again when the run finishes.
      push('checks_running', PR_PRIORITY_WEIGHTS.checksRunning);
    }
  }

  // Approved by everyone else and still requested of you: your click is the
  // last thing between this PR and its author's day continuing.
  if (decision === 'APPROVED') {
    push('last_approval', PR_PRIORITY_WEIGHTS.lastApproval);
  }

  // A person put your name on this rather than a team being auto-assigned.
  // Kept as a rule rather than a learned feature — see `reviewRank.ts` for why
  // the training data cannot answer this one honestly.
  if (s.reviewRequestVia?.direct) {
    push('direct_request', PR_PRIORITY_WEIGHTS.directRequest);
  }

  // The human/bot asymmetry is Tricorder's rule: a bot finding is not an
  // attention event until a person promotes it. An unresolved thread a HUMAN
  // opened usually means the author is mid-revision, so the ball is not with
  // you; a bot's nit means only that the diff will churn a little.
  // Human threads NOT opened by the viewer. Without the subtraction a PR is
  // penalised for the very threads that make it the viewer's to come back to,
  // which cancels the `your_threads` reward below and makes both pointless.
  const othersThreads = Math.max(
    0,
    (s.unresolvedHumanReviewThreads ?? 0) - (s.unresolvedThreadsOpenedByViewer ?? 0),
  );
  if (othersThreads > 0) {
    push('human_threads', PR_PRIORITY_WEIGHTS.humanThreads);
  }
  if ((s.unresolvedBotReviewThreads ?? 0) > 0) {
    push('bot_threads', PR_PRIORITY_WEIGHTS.botThreads);
  }

  // GitHub's own answer first, the login only as a fallback for rows cached
  // before the field shipped. The login alone catches `dependabot[bot]` and
  // misses a GitHub App with no suffix, and an Organization account — which is
  // how PostHog's own automation opens PRs, under the perfectly human-looking
  // name `@PostHog`. Absent stays UNKNOWN: a PR is left in the list rather than
  // demoted on a guess.
  const machineAuthored = s.prAuthorIsBot ?? /\[bot\]$/i.test(s.author ?? '');
  if (machineAuthored) {
    push('bot_author', PR_PRIORITY_WEIGHTS.botAuthor);
  }

  // Real diff size, when the row has been refreshed since it started being
  // fetched. `changedFiles` is deliberately NOT used as a fallback: a one-line
  // fix across twelve files reads as bigger by file count than a 900-line
  // rewrite of one, so the two disagree most on the PRs it matters for.
  const lines =
    s.additions === undefined && s.deletions === undefined
      ? undefined
      : (s.additions ?? 0) + (s.deletions ?? 0);
  const sizePts = sizePoints(lines);
  if (sizePts !== 0) {
    push('size', sizePts, lines !== undefined && sizePts > 0 ? `(${lines} lines)` : undefined);
  }

  // You have already read this PR and asked for changes; the author has
  // pushed and re-requested you. That is work in progress rather than work to
  // start, and it is cheaper to finish than an equivalent PR you have never
  // opened. Only a CHANGES_REQUESTED review counts — an approval you later
  // got re-requested on is a fresh look at a PR that moved on.
  if (s.viewerLatestReview?.state === 'CHANGES_REQUESTED') {
    push('re_review', PR_PRIORITY_WEIGHTS.reReview);
  }

  // Threads YOU opened and nobody has resolved. The mirror of `human_threads`
  // directly above, and the opposite signal: that one says another person is
  // mid-conversation with the author, so the ball is not with you; this one
  // says the conversation is YOURS and is waiting. Netted out of the human
  // count so a PR is not penalised for the very threads that make it yours.
  const yours = s.unresolvedThreadsOpenedByViewer ?? 0;
  if (yours > 0) {
    push('your_threads', PR_PRIORITY_WEIGHTS.yourThreads, String(yours));
  }

  const since =
    parseTime(row.reviewRequestedFirstSeenAt) ??
    parseTime(s.createdAt) ??
    parseTime(row.createdAt);
  if (since !== null) {
    const hours = (ctx.now - since) / 3_600_000;
    const pts = agePoints(hours);
    if (pts > 0) push('waited', pts, humaniseWait(hours));
  }

  // Gate markers score 0, so they sort to the end here and contribute nothing
  // to the total — both of which are what we want.
  // ---- the learned term -----------------------------------------------
  // Everything above is a rule over LIVE state. This is the only part fitted
  // from the viewer's own history, and it is deliberately the smaller half —
  // see PR_PRIORITY_WEIGHTS.learnedCap.
  const inputs = rankingInputs(row, ctx);
  if (ctx.pooledScore !== undefined && Number.isFinite(ctx.pooledScore)) {
    push('shared_model', Math.round(PR_PRIORITY_WEIGHTS.learnedCap * Math.tanh(ctx.pooledScore / 2)));
  } else if (inputs) {
    const { weights, stats, features: raw } = inputs;
    // Without stored stats the features are on raw scales the weights were
    // never fitted against, so scoring them would be arithmetic on mismatched
    // units. Skipping is the honest answer — the deterministic terms still rank.
    if (stats && stats.sd.length === raw.length) {
      const std = standardize(raw, stats);
      const total = applyReviewRank(std, weights);
      // A logistic-shaped squash, so an unusual PR cannot run away with the
      // list: ±18 is approached, never exceeded, and the clamp is a property of
      // the curve rather than a truncation that flattens everything past it.
      const scaled =
        PR_PRIORITY_WEIGHTS.learnedCap * (2 / (1 + Math.exp(-total)) - 1);
      const contributions = reviewRankContributions(std, weights);
      const share = total === 0 ? 0 : scaled / total;

      // Apportion the total across the features as INTEGERS that sum to it
      // exactly (largest remainder). Rounding each independently is the obvious
      // approach and it breaks the cap: five roundings of up to a half each can
      // overshoot by two and a half points, which is enough to let the model
      // outweigh a whole deterministic term.
      const exact = contributions.map((c) => c.value * share);
      const target = Math.round(scaled);
      const floors = exact.map((v) => Math.trunc(v));
      let remainder = target - floors.reduce((a, b) => a + b, 0);
      const order = exact
        .map((v, i) => ({ i, frac: Math.abs(v - floors[i]) }))
        .sort((a, b) => b.frac - a.frac);
      const points = [...floors];
      for (const { i } of order) {
        if (remainder === 0) break;
        const step = remainder > 0 ? 1 : -1;
        points[i] += step;
        remainder -= step;
      }
      contributions.forEach((c, i) => {
        if (points[i] !== 0) push(LEARNED_REASON[c.feature], points[i]);
      });
    }
  }

  terms.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  const score = terms.reduce((sum, t) => sum + t.points, 0);

  // Pick the chip from a view in which the LEARNED contribution counts as ONE
  // candidate, not five.
  //
  // Without this the model can never be named, whatever it does. Age is a
  // single term worth up to 16; the learned signal is capped at 12 in TOTAL and
  // then apportioned across five features, so each part averages around 2.4.
  // Comparing those parts against age individually means age wins essentially
  // always — and a list the model has genuinely reordered reads as a plain age
  // sort, which is indistinguishable from the model not existing. That is the
  // exact confusion this chip is meant to prevent.
  //
  // The FULL per-feature breakdown stays in `terms`, which is what the tooltip
  // renders. Only the headline is collapsed.
  const learned = terms.filter((t) => LEARNED_REASONS.has(t.reason));
  const learnedTotal = learned.reduce((sum, t) => sum + t.points, 0);
  const candidates: PRPriorityTerm[] = terms.filter((t) => !LEARNED_REASONS.has(t.reason));
  if (learned.length > 0 && learnedTotal !== 0) {
    // Named by its largest component, because "you review them often" says
    // something a person can act on and "your profile likes this" does not.
    const lead = learned.reduce((a, b) => (Math.abs(b.points) > Math.abs(a.points) ? b : a));
    candidates.push({ reason: lead.reason, points: learnedTotal, detail: lead.detail });
  }
  candidates.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  const positive = candidates.find((t) => t.points > 0) ?? null;
  const marker = candidates.find((t) => t.gateMarker) ?? null;
  const negative = candidates.find((t) => t.points < 0) ?? null;

  // A gate marker ALWAYS wins the chip, because it is why the row is where it
  // is. The points only decide the order among its neighbours, and saying the
  // nicest true thing about a row instead of the reason it moved is actively
  // misleading in both directions: a buried draft reading "All checks green"
  // explains the opposite of what happened, and a PR at the very top reading
  // the same thing hides that an armed auto-merge is what put it there.
  //
  // A row in `actionable` never carries a marker, so the positive term wins
  // there by construction rather than by a branch.
  const topReason = marker ?? positive ?? negative;

  const verdict: PRPriorityVerdict = { gate, score, terms, topReason };
  if (ctx.captureTrace) verdict.trace = scoringTrace(row, ctx, agentRunning, inputs);
  return verdict;
}

/**
 * Order two rows by their pre-computed verdicts.
 *
 * The tail of the key is what keeps the list still. Without the final `id`,
 * two tied PRs swap places between polls, which reads as a bug rather than as
 * a tie — and ties are common, because most PRs pick up the same handful of
 * terms.
 */
export function comparePRByPriority(
  a: PRPriorityTarget,
  b: PRPriorityTarget,
  verdicts: Map<string, PRPriorityVerdict>,
): number {
  const va = verdicts.get(a.id);
  const vb = verdicts.get(b.id);
  // An unscored row sorts last rather than throwing: the map is built from the
  // same list, so a miss means a bug upstream, and a blank row at the bottom is
  // a far better failure than a crashed panel.
  if (!va && !vb) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (!va) return 1;
  if (!vb) return -1;

  const gateDiff = PR_PRIORITY_GATE_RANK[vb.gate] - PR_PRIORITY_GATE_RANK[va.gate];
  if (gateDiff !== 0) return gateDiff;

  if (vb.score !== va.score) return vb.score - va.score;

  const ta = parseTime(a.summary?.createdAt) ?? parseTime(a.createdAt) ?? 0;
  const tb = parseTime(b.summary?.createdAt) ?? parseTime(b.createdAt) ?? 0;
  if (ta !== tb) return ta - tb; // older first among equals

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Score a whole list once, into the map {@link comparePRByPriority} reads.
 *
 * The only supported way to use this module from a component: it pins `now`
 * for the whole pass and guarantees one scoring per row.
 */
export function buildPRPriorityMap(
  rows: PRPriorityTarget[],
  ctx: PRPriorityContext,
): Map<string, PRPriorityVerdict> {
  const map = new Map<string, PRPriorityVerdict>();
  for (const row of rows) map.set(row.id, scorePRForReview(row, ctx));
  return map;
}

/**
 * Whether the Reviews sort control should offer its third state at all.
 *
 * The three-state rule `workflowsOffered` documents: `null` means the
 * capability answer has not arrived, and drawing on that flashes the control's
 * extra state in on every launch. Not authorisation — the model endpoint and
 * the backfill gate independently, and the ordering itself is harmless because
 * it is a pure function over rows the client already holds.
 */
export function reviewPriorityOffered(
  features: { reviewPriority?: boolean; reviewPriorityMode?: boolean } | null | undefined,
): boolean {
  return (features?.reviewPriorityMode ?? features?.reviewPriority) === true;
}
