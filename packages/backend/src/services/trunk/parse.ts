import type {
  TrunkEtaConfidence,
  TrunkEtaPace,
  TrunkMergeEta,
  TrunkQueueState,
} from '@talyn/shared';

/**
 * Parsing Trunk's v2 answers into the shared vocabulary.
 *
 * Trunk may add enum members and fields within v2, so nothing here fails on one
 * it does not know: a wrong type reads as absent, an unknown enum value reads as
 * `unknown`, and no parser throws. A malformed answer is "no ETA", not a 500.
 */

/** What the merge-eta route needs out of Trunk's pull-request record. */
export interface ParsedTrunkPullRequest {
  /** Trunk's own id for the PR, which the estimate is addressed by. */
  id: string | null;
  queueState: TrunkQueueState | null;
  stateChangedAt: string | null;
  /** Trunk's own "is this PR in the queue now". Null when absent. */
  isCurrentlySubmitted: boolean | null;
}

const QUEUE_STATES: Readonly<Record<string, TrunkQueueState>> = {
  notReady: 'not_ready',
  pending: 'pending',
  testing: 'testing',
  testsPassed: 'tests_passed',
  merged: 'merged',
  failed: 'failed',
  cancelled: 'cancelled',
  pendingFailure: 'pending_failure',
};

const PACES: Readonly<Record<string, TrunkEtaPace>> = {
  onTrack: 'on_track',
  holding: 'holding',
  pastTypical: 'behind',
  pastP95: 'behind',
};

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
  const s = str(x);
  return (s !== null && PACES[s]) || 'unknown';
}

function confidence(x: unknown): TrunkEtaConfidence {
  const s = str(x);
  return s === 'high' || s === 'medium' || s === 'low' ? s : 'unknown';
}

function pageRows(raw: unknown): Record<string, unknown>[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return [];
  return raw.data.filter(isRecord);
}

export function parseTrunkQueueState(x: unknown): TrunkQueueState | null {
  const s = str(x);
  if (s === null) return null;
  return QUEUE_STATES[s] ?? 'unknown';
}

/** The repository id out of a `GET /v2/repositories` page, or null. */
export function parseTrunkRepositoryId(raw: unknown): string | null {
  return str(pageRows(raw)[0]?.id);
}

/**
 * The record for PR `number` out of a `GET /v2/pull-requests` page, or null
 * when Trunk has not indexed it.
 */
export function parseTrunkPullRequest(raw: unknown, number: number): ParsedTrunkPullRequest | null {
  const row = pageRows(raw).find((r) => r.number === number);
  if (!row) return null;
  const entry = isRecord(row.queueEntry) ? row.queueEntry : null;
  return {
    id: str(row.id),
    queueState: entry ? parseTrunkQueueState(entry.state) : null,
    stateChangedAt: entry ? time(entry.stateChangedAt) : null,
    isCurrentlySubmitted:
      typeof row.isCurrentlySubmittedToQueue === 'boolean' ? row.isCurrentlySubmittedToQueue : null,
  };
}

/**
 * A `queue-entry-estimate` answer. Null unless `status` is exactly `available`
 * AND at least one of the three predicted times is a real time — an
 * "available" estimate with no time in it has nothing to count down to.
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
