// Trunk merge-queue ETAs: the shape `GET /pull-requests/:id/merge-eta` answers,
// and the one formatter both front ends render it with.
//
// The backend asks Trunk's `getSubmittedPullRequest` with
// `includeEstimatedTimeToMerge: true`. Those ETA fields are not in Trunk's
// published OpenAPI spec yet, so the backend parser treats every field as
// optional and maps any enum value it does not know to `unknown`.

import type { ExternalQueueState } from './externalMergeQueue.js';

/**
 * A PR's state in Trunk's queue, as Trunk's API names it. This is a different
 * vocabulary from {@link ExternalQueueState}, which is read off Trunk's PR
 * comment. `unknown` is any value the spec does not list.
 */
export type TrunkQueueState =
  | 'not_ready'
  | 'pending'
  | 'testing'
  | 'tests_passed'
  | 'merged'
  | 'failed'
  | 'cancelled'
  | 'pending_failure'
  | 'unknown';

/**
 * Whether one of Trunk's predicted times is keeping to plan. Trunk sends
 * `on_track` and `holding`. `behind` covers only values that clearly mean late.
 * Everything else is `unknown`, and nothing renders from `unknown`.
 */
export type TrunkEtaPace = 'on_track' | 'holding' | 'behind' | 'unknown';

export type TrunkEtaConfidence = 'high' | 'medium' | 'low' | 'unknown';

/** Trunk's estimate for one PR. Times are ISO strings; any can be null. */
export interface TrunkMergeEta {
  computedAt: string | null;
  /** Trunk's `kind`, verbatim (for example `merge`). Not interpreted. */
  kind: string | null;
  estimatedAt: string | null;
  estimatedAtState: TrunkEtaPace;
  confidence: TrunkEtaConfidence;
  pullRequestsAhead: number | null;
  waitingForPullRequestNumbers: number[];
  sampleSize: number | null;
  startsTestingAt: string | null;
  startsTestingAtState: TrunkEtaPace;
  testsFinishAt: string | null;
  testsFinishAtState: TrunkEtaPace;
  typicalTestDurationSeconds: number | null;
}

/** Why an answer carries no ETA. */
export type MergeEtaReason =
  /** The workspace has no Trunk token. */
  | 'no_token'
  /** Trunk refused the token (401/403). Settings shows "Reconnect". */
  | 'reauth_required'
  /** The PR is not in Trunk's queue (or is closed). */
  | 'not_queued'
  /** Trunk has the PR but no estimate for it. */
  | 'no_estimate'
  /** Trunk could not be reached or answered with an error. */
  | 'unavailable';

/** The body of `GET /pull-requests/:id/merge-eta`. */
export interface MergeEtaAnswer {
  eta: TrunkMergeEta | null;
  reason?: MergeEtaReason;
  /** Trunk's own state for the PR, when Trunk was asked and said. */
  queueState?: TrunkQueueState;
  stateChangedAt?: string;
  /** When the backend asked Trunk (or decided not to). */
  fetchedAt: string;
}

/** The body of `GET /trunk/status`. The token itself never leaves the backend. */
export interface TrunkIntegrationStatus {
  connected: boolean;
  /** Trunk refused the stored token. Saving a new one clears this. */
  needsReauth: boolean;
  reauthReason?: string;
  connectedAt?: string;
}

/**
 * The comment- and label-derived states in which Trunk still has the PR.
 * The front ends ask for an ETA only for these.
 */
const IN_QUEUE_STATES: ReadonlySet<ExternalQueueState> = new Set<ExternalQueueState>([
  'not_ready',
  'queued',
  'testing',
  'passed',
  'pending_failure',
]);

export function externalQueueStateIsInQueue(
  state: ExternalQueueState | null | undefined
): boolean {
  return state != null && IN_QUEUE_STATES.has(state);
}

/**
 * The time from `nowMs` to `targetIso`, for a person to read.
 *
 * Rounds UP to whole minutes, so "~1 min" never means "already done". From an
 * hour up it rounds to the nearest 5 minutes, because an hour-out estimate is
 * not precise to the minute. A time at or before now is "any moment": a
 * negative countdown only says the estimate was late. Returns null for a
 * missing or unparseable time.
 */
export function formatEtaDuration(
  targetIso: string | null | undefined,
  nowMs: number
): string | null {
  if (!targetIso) return null;
  const target = Date.parse(targetIso);
  if (!Number.isFinite(target) || !Number.isFinite(nowMs)) return null;
  const diffMs = target - nowMs;
  if (diffMs <= 0) return 'any moment';
  let minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `~${minutes} min`;
  minutes = Math.round(minutes / 5) * 5;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `~${hours} h` : `~${hours} h ${rest} min`;
}

/** What a PR row draws for an ETA. */
export interface MergeEtaView {
  /** "Will merge in ~N min", or null when Trunk gave no merge time. */
  headline: string | null;
  /** "Testing · ~N min left" / "Starts testing in ~N min", then "N PRs ahead". */
  details: string[];
  /** A predicted time is behind plan. Drawn muted, never as an error. */
  runningLong: boolean;
}

/**
 * Turn an answer into the lines a row draws, at `nowMs`. Called on every local
 * tick, so the countdown moves between fetches. Null when there is nothing to
 * draw.
 */
export function describeMergeEta(answer: MergeEtaAnswer | null, nowMs: number): MergeEtaView | null {
  const eta = answer?.eta;
  if (!eta) return null;

  const mergeIn = formatEtaDuration(eta.estimatedAt, nowMs);
  const headline =
    mergeIn === null ? null : mergeIn === 'any moment' ? 'Will merge any moment' : `Will merge in ${mergeIn}`;

  const details: string[] = [];
  const startsMs = eta.startsTestingAt ? Date.parse(eta.startsTestingAt) : NaN;
  // Trunk's own state decides when it is present. Without it, a start time
  // already passed plus a finish time means testing has started.
  const testing =
    answer?.queueState === 'testing' ||
    ((answer?.queueState === undefined || answer.queueState === 'unknown') &&
      Number.isFinite(startsMs) &&
      startsMs <= nowMs &&
      eta.testsFinishAt !== null);
  if (testing) {
    const left = formatEtaDuration(eta.testsFinishAt, nowMs);
    if (left === null) details.push('Testing');
    else if (left === 'any moment') details.push('Testing · finishing any moment');
    else details.push(`Testing · ${left} left`);
  } else {
    const starts = formatEtaDuration(eta.startsTestingAt, nowMs);
    if (starts === 'any moment') details.push('Starts testing any moment');
    else if (starts !== null) details.push(`Starts testing in ${starts}`);
  }
  const ahead = eta.pullRequestsAhead;
  if (ahead !== null && ahead > 0) details.push(`${ahead} ${ahead === 1 ? 'PR' : 'PRs'} ahead`);

  const runningLong =
    eta.estimatedAtState === 'behind' ||
    eta.startsTestingAtState === 'behind' ||
    eta.testsFinishAtState === 'behind';

  if (headline === null && details.length === 0) return null;
  return { headline, details, runningLong };
}
