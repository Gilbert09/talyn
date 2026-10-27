import type {
  TrunkEtaConfidence,
  TrunkEtaPace,
  TrunkMergeEta,
  TrunkQueueState,
} from '@talyn/shared';

/**
 * Parsing Trunk's `getSubmittedPullRequest` answer.
 *
 * The ETA block (`estimatedTimeToMerge`) is not in Trunk's published OpenAPI
 * spec yet, so nothing here trusts its shape. Every field is optional, a wrong
 * type reads as absent, and an enum value we do not know reads as `unknown`.
 * The parser never throws: a malformed answer is "no ETA", not a 500.
 */

/** What the merge-eta route needs out of one answer. */
export interface ParsedTrunkPullRequest {
  queueState: TrunkQueueState | null;
  stateChangedAt: string | null;
  /** Trunk's own "is this PR in the queue now". Null when absent. */
  isCurrentlySubmitted: boolean | null;
  eta: TrunkMergeEta | null;
}

const QUEUE_STATES: ReadonlySet<string> = new Set([
  'not_ready',
  'pending',
  'testing',
  'tests_passed',
  'merged',
  'failed',
  'cancelled',
  'pending_failure',
]);

// Only values that clearly mean late. A guess here would draw "running long"
// on an estimate that is fine, so an unlisted value stays `unknown`.
const BEHIND_VALUES: ReadonlySet<string> = new Set([
  'behind',
  'late',
  'running_late',
  'running_long',
  'overdue',
  'delayed',
  'overrun',
  'taking_longer_than_usual',
]);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function str(x: unknown): string | null {
  return typeof x === 'string' && x.length > 0 ? x : null;
}

/** An ISO time we can do arithmetic on, or null. */
function time(x: unknown): string | null {
  const s = str(x);
  return s !== null && Number.isFinite(Date.parse(s)) ? s : null;
}

function count(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null;
}

function pace(x: unknown): TrunkEtaPace {
  const s = str(x)?.toLowerCase();
  if (!s) return 'unknown';
  if (s === 'on_track' || s === 'holding') return s;
  return BEHIND_VALUES.has(s) ? 'behind' : 'unknown';
}

function confidence(x: unknown): TrunkEtaConfidence {
  const s = str(x)?.toLowerCase();
  return s === 'high' || s === 'medium' || s === 'low' ? s : 'unknown';
}

export function parseTrunkQueueState(x: unknown): TrunkQueueState | null {
  const s = str(x);
  if (s === null) return null;
  return QUEUE_STATES.has(s) ? (s as TrunkQueueState) : 'unknown';
}

/**
 * The ETA block alone. Null unless `status` is exactly `available` AND at least
 * one of the three predicted times is a real time — an "available" estimate
 * with no time in it has nothing to count down to.
 */
export function parseTrunkEstimate(raw: unknown): TrunkMergeEta | null {
  if (!isRecord(raw) || raw.status !== 'available') return null;
  const estimatedAt = time(raw.estimatedAt);
  const startsTestingAt = time(raw.startsTestingAt);
  const testsFinishAt = time(raw.testsFinishAt);
  if (estimatedAt === null && startsTestingAt === null && testsFinishAt === null) return null;
  const waiting = Array.isArray(raw.waitingForPullRequestNumbers)
    ? raw.waitingForPullRequestNumbers.filter(
        (n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0
      )
    : [];
  return {
    computedAt: time(raw.computedAt),
    kind: str(raw.kind),
    estimatedAt,
    estimatedAtState: pace(raw.estimatedAtState),
    confidence: confidence(raw.confidence),
    pullRequestsAhead: count(raw.pullRequestsAhead),
    waitingForPullRequestNumbers: waiting,
    sampleSize: count(raw.sampleSize),
    startsTestingAt,
    startsTestingAtState: pace(raw.startsTestingAtState),
    testsFinishAt,
    testsFinishAtState: pace(raw.testsFinishAtState),
    typicalTestDurationSeconds: count(raw.typicalTestDurationSeconds),
  };
}

/** The whole answer. Accepts anything; never throws. */
export function parseTrunkSubmittedPullRequest(raw: unknown): ParsedTrunkPullRequest {
  if (!isRecord(raw)) {
    return { queueState: null, stateChangedAt: null, isCurrentlySubmitted: null, eta: null };
  }
  return {
    queueState: parseTrunkQueueState(raw.state),
    stateChangedAt: time(raw.stateChangedAt),
    isCurrentlySubmitted:
      typeof raw.isCurrentlySubmittedToQueue === 'boolean' ? raw.isCurrentlySubmittedToQueue : null,
    eta: parseTrunkEstimate(raw.estimatedTimeToMerge),
  };
}
