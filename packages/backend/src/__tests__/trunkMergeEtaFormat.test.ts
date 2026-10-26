import { describe, it, expect } from 'vitest';
import {
  describeMergeEta,
  externalQueueStateIsInQueue,
  formatEtaDuration,
  type MergeEtaAnswer,
  type TrunkMergeEta,
} from '@talyn/shared';

/**
 * The one countdown formatter both front ends draw Trunk's ETA with. It lives
 * in `@talyn/shared`, so it is tested once, here.
 */

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const SEC = 1_000;
const MIN = 60 * SEC;

describe('formatEtaDuration', () => {
  it.each([
    ['1 second', 1 * SEC, '~1 min'],
    ['30 seconds', 30 * SEC, '~1 min'],
    ['59 seconds', 59 * SEC, '~1 min'],
    ['exactly 1 minute', 1 * MIN, '~1 min'],
    ['1 minute 1 second', 1 * MIN + 1 * SEC, '~2 min'],
    ['exactly 2 minutes', 2 * MIN, '~2 min'],
    ['exactly 10 minutes', 10 * MIN, '~10 min'],
    ['10 minutes 1 ms', 10 * MIN + 1, '~11 min'],
    ['58 minutes 30 seconds', 58 * MIN + 30 * SEC, '~59 min'],
    ['59 minutes', 59 * MIN, '~59 min'],
    ['59 minutes 1 second', 59 * MIN + 1 * SEC, '~1 h'],
    ['exactly 1 hour', 60 * MIN, '~1 h'],
    ['61 minutes', 61 * MIN, '~1 h'],
    ['62 minutes', 62 * MIN, '~1 h'],
    ['63 minutes', 63 * MIN, '~1 h 5 min'],
    ['67 minutes', 67 * MIN, '~1 h 5 min'],
    ['68 minutes', 68 * MIN, '~1 h 10 min'],
    ['1 hour 57 minutes 30 seconds', 117 * MIN + 30 * SEC, '~2 h'],
    ['2 hours 22 minutes', 142 * MIN, '~2 h 20 min'],
    ['2 hours 23 minutes', 143 * MIN, '~2 h 25 min'],
    ['exactly 3 hours', 180 * MIN, '~3 h'],
  ])('%s from now reads %s', (_name, ms, expected) => {
    expect(formatEtaDuration(at(ms), NOW)).toBe(expected);
  });

  it.each([
    ['exactly now', 0],
    ['1 ms ago', -1],
    ['a minute ago', -MIN],
    ['a day ago', -24 * 60 * MIN],
  ])('%s reads "any moment", never a negative number', (_name, ms) => {
    expect(formatEtaDuration(at(ms), NOW)).toBe('any moment');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['an unparseable string', 'soon'],
  ])('answers null for %s', (_name, value) => {
    expect(formatEtaDuration(value, NOW)).toBeNull();
  });

  it('answers null for a now that is not a number', () => {
    expect(formatEtaDuration(at(MIN), Number.NaN)).toBeNull();
  });
});

function eta(over: Partial<TrunkMergeEta> = {}): TrunkMergeEta {
  return {
    computedAt: at(0),
    kind: 'merge',
    estimatedAt: at(20 * MIN),
    estimatedAtState: 'on_track',
    confidence: 'high',
    pullRequestsAhead: 2,
    waitingForPullRequestNumbers: [],
    sampleSize: 40,
    startsTestingAt: at(5 * MIN),
    startsTestingAtState: 'holding',
    testsFinishAt: at(15 * MIN),
    testsFinishAtState: 'on_track',
    typicalTestDurationSeconds: 600,
    ...over,
  };
}

function answer(e: TrunkMergeEta | null, over: Partial<MergeEtaAnswer> = {}): MergeEtaAnswer {
  return { eta: e, fetchedAt: at(0), ...over };
}

describe('describeMergeEta', () => {
  it('draws a queued PR: when it merges, when it starts testing, and the queue ahead', () => {
    expect(describeMergeEta(answer(eta(), { queueState: 'pending' }), NOW)).toEqual({
      headline: 'Will merge in ~20 min',
      details: ['Starts testing in ~5 min', '2 PRs ahead'],
      runningLong: false,
    });
  });

  it('draws a testing PR with the time left', () => {
    expect(
      describeMergeEta(
        answer(eta({ startsTestingAt: at(-7 * MIN), pullRequestsAhead: 0 }), { queueState: 'testing' }),
        NOW
      )
    ).toEqual({ headline: 'Will merge in ~20 min', details: ['Testing · ~15 min left'], runningLong: false });
  });

  it('infers testing from the times when Trunk did not send a state', () => {
    const view = describeMergeEta(answer(eta({ startsTestingAt: at(-1 * MIN) })), NOW);
    expect(view?.details[0]).toBe('Testing · ~15 min left');
  });

  it('trusts Trunk’s state over the times', () => {
    // A start time in the past on a PR Trunk says is still pending: it is late
    // to start, not testing.
    const view = describeMergeEta(
      answer(eta({ startsTestingAt: at(-1 * MIN) }), { queueState: 'pending' }),
      NOW
    );
    expect(view?.details[0]).toBe('Starts testing any moment');
  });

  it('says "any moment" for times that have passed', () => {
    const view = describeMergeEta(
      answer(eta({ estimatedAt: at(-MIN), testsFinishAt: at(-2 * MIN) }), { queueState: 'testing' }),
      NOW
    );
    expect(view?.headline).toBe('Will merge any moment');
    expect(view?.details[0]).toBe('Testing · finishing any moment');
  });

  it.each([
    [1, '1 PR ahead'],
    [3, '3 PRs ahead'],
  ])('counts %i PR(s) ahead', (n, text) => {
    expect(describeMergeEta(answer(eta({ pullRequestsAhead: n })), NOW)?.details).toContain(text);
  });

  it.each([0, null])('leaves out the queue line for %j PRs ahead', (n) => {
    const details = describeMergeEta(answer(eta({ pullRequestsAhead: n })), NOW)?.details ?? [];
    expect(details.some((d) => d.includes('ahead'))).toBe(false);
  });

  it.each([
    ['estimatedAtState', { estimatedAtState: 'behind' as const }, true],
    ['startsTestingAtState', { startsTestingAtState: 'behind' as const }, true],
    ['testsFinishAtState', { testsFinishAtState: 'behind' as const }, true],
    ['holding', { startsTestingAtState: 'holding' as const }, false],
    ['unknown', { estimatedAtState: 'unknown' as const }, false],
  ])('marks running long from %s', (_name, over, expected) => {
    expect(describeMergeEta(answer(eta(over)), NOW)?.runningLong).toBe(expected);
  });

  it('draws the details alone when Trunk gave no merge time', () => {
    expect(describeMergeEta(answer(eta({ estimatedAt: null })), NOW)).toEqual({
      headline: null,
      details: ['Starts testing in ~5 min', '2 PRs ahead'],
      runningLong: false,
    });
  });

  it.each([
    ['no answer', null],
    ['no eta', answer(null, { reason: 'no_estimate' })],
    [
      'an eta with nothing to draw',
      answer(eta({ estimatedAt: null, startsTestingAt: null, testsFinishAt: null, pullRequestsAhead: 0 })),
    ],
  ])('draws nothing for %s', (_name, a) => {
    expect(describeMergeEta(a, NOW)).toBeNull();
  });
});

describe('externalQueueStateIsInQueue', () => {
  it.each([
    ['not_ready', true],
    ['queued', true],
    ['testing', true],
    ['passed', true],
    ['pending_failure', true],
    ['not_submitted', false],
    ['failed', false],
    ['ejected', false],
    ['cancelled', false],
    ['rejected', false],
    ['merged', false],
    [null, false],
    [undefined, false],
  ] as const)('%s → %s', (state, expected) => {
    expect(externalQueueStateIsInQueue(state)).toBe(expected);
  });
});
