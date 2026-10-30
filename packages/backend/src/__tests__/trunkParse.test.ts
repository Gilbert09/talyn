import { describe, it, expect } from 'vitest';
import {
  parseTrunkEstimate,
  parseTrunkPullRequest,
  parseTrunkQueueState,
  parseTrunkRepositoryId,
} from '../services/trunk/parse.js';

/**
 * Trunk may add enum members and fields within v2, so the parser trusts
 * nothing. These pin the two promises that follow: a malformed answer is "no
 * ETA" (never a throw), and an enum value we do not know is `unknown` (never a
 * guess).
 */

const AVAILABLE = {
  status: 'available',
  computedAt: '2026-10-23T12:00:00.000Z',
  kind: 'merge',
  estimatedAt: '2026-10-23T12:20:00.000Z',
  estimatedAtState: 'onTrack',
  confidence: 'high',
  pullRequestsAhead: 2,
  waitingForPullRequestNumbers: [],
  sampleSize: 40,
  startsTestingAt: '2026-10-23T12:05:00.000Z',
  startsTestingAtState: 'holding',
  testsFinishAt: '2026-10-23T12:15:00.000Z',
  testsFinishAtState: 'onTrack',
  typicalTestDurationSeconds: 600,
};

describe('parseTrunkEstimate', () => {
  it('reads Trunk’s example payload field by field', () => {
    expect(parseTrunkEstimate(AVAILABLE)).toEqual({
      computedAt: '2026-10-23T12:00:00.000Z',
      kind: 'merge',
      estimatedAt: '2026-10-23T12:20:00.000Z',
      estimatedAtState: 'on_track',
      confidence: 'high',
      pullRequestsAhead: 2,
      waitingForPullRequestNumbers: [],
      sampleSize: 40,
      startsTestingAt: '2026-10-23T12:05:00.000Z',
      startsTestingAtState: 'holding',
      testsFinishAt: '2026-10-23T12:15:00.000Z',
      testsFinishAtState: 'on_track',
      typicalTestDurationSeconds: 600,
    });
  });

  it.each([
    ['unavailable', { ...AVAILABLE, status: 'unavailable' }],
    ['insufficient data', { ...AVAILABLE, status: 'insufficient_data' }],
    ['a status in another case', { ...AVAILABLE, status: 'Available' }],
    ['no status', { ...AVAILABLE, status: undefined }],
    ['a numeric status', { ...AVAILABLE, status: 1 }],
    ['available with no times', { status: 'available', confidence: 'high' }],
    ['available with only bad times', { status: 'available', estimatedAt: 'soon', testsFinishAt: 42 }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'available'],
    ['an array', [AVAILABLE]],
    ['a number', 7],
  ])('answers null for %s', (_name, raw) => {
    expect(parseTrunkEstimate(raw)).toBeNull();
  });

  it.each([
    ['onTrack', 'on_track'],
    ['holding', 'holding'],
    ['pastTypical', 'behind'],
    ['pastP95', 'behind'],
    ['on_track', 'unknown'],
    ['ontrack', 'unknown'],
    ['ahead', 'unknown'],
    ['', 'unknown'],
    [7, 'unknown'],
    [null, 'unknown'],
  ])('reads a %j pace as %s', (value, expected) => {
    const eta = parseTrunkEstimate({ ...AVAILABLE, estimatedAtState: value, testsFinishAtState: value });
    expect(eta?.estimatedAtState).toBe(expected);
    expect(eta?.testsFinishAtState).toBe(expected);
  });

  it.each([
    ['high', 'high'],
    ['medium', 'medium'],
    ['low', 'low'],
    ['very_high', 'unknown'],
    [3, 'unknown'],
    [undefined, 'unknown'],
  ])('reads a %j confidence as %s', (value, expected) => {
    expect(parseTrunkEstimate({ ...AVAILABLE, confidence: value })?.confidence).toBe(expected);
  });

  it('keeps an estimate that has only some of its times', () => {
    const eta = parseTrunkEstimate({ status: 'available', testsFinishAt: '2026-10-23T12:15:00Z' });
    expect(eta).toMatchObject({
      estimatedAt: null,
      startsTestingAt: null,
      testsFinishAt: '2026-10-23T12:15:00Z',
      estimatedAtState: 'unknown',
      confidence: 'unknown',
      pullRequestsAhead: null,
      waitingForPullRequestNumbers: [],
      sampleSize: null,
      kind: null,
      computedAt: null,
      typicalTestDurationSeconds: null,
    });
  });

  it.each([
    ['a negative count', -1, null],
    ['a fraction', 2.7, 2],
    ['a string', '2', null],
    ['NaN', Number.NaN, null],
    ['Infinity', Number.POSITIVE_INFINITY, null],
    ['zero', 0, 0],
  ])('reads %s of PRs ahead safely', (_name, value, expected) => {
    expect(parseTrunkEstimate({ ...AVAILABLE, pullRequestsAhead: value })?.pullRequestsAhead).toBe(
      expected
    );
  });

  it('drops anything in the waiting list that is not a PR number', () => {
    const eta = parseTrunkEstimate({
      ...AVAILABLE,
      waitingForPullRequestNumbers: [12, '13', -1, 0, 1.5, null, 14],
    });
    expect(eta?.waitingForPullRequestNumbers).toEqual([12, 14]);
  });

  it('reads a waiting list that is not an array as empty', () => {
    expect(
      parseTrunkEstimate({ ...AVAILABLE, waitingForPullRequestNumbers: 'x' })
        ?.waitingForPullRequestNumbers
    ).toEqual([]);
  });

  it('drops an unparseable time and keeps the others', () => {
    const eta = parseTrunkEstimate({ ...AVAILABLE, startsTestingAt: 'in five minutes' });
    expect(eta?.startsTestingAt).toBeNull();
    expect(eta?.estimatedAt).toBe(AVAILABLE.estimatedAt);
  });
});

describe('parseTrunkQueueState', () => {
  it.each([
    ['notReady', 'not_ready'],
    ['pending', 'pending'],
    ['testing', 'testing'],
    ['testsPassed', 'tests_passed'],
    ['merged', 'merged'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['pendingFailure', 'pending_failure'],
  ])('maps the documented state %s to %s', (state, expected) => {
    expect(parseTrunkQueueState(state)).toBe(expected);
  });

  it.each([
    ['an undocumented state', 'bisecting', 'unknown'],
    ['a different case', 'TESTING', 'unknown'],
    ['a v1 spelling', 'tests_passed', 'unknown'],
    ['an empty string', '', null],
    ['a number', 3, null],
    ['null', null, null],
  ])('reads %s as %j', (_name, value, expected) => {
    expect(parseTrunkQueueState(value)).toBe(expected);
  });
});

describe('parseTrunkRepositoryId', () => {
  it('reads the first repository on the page', () => {
    expect(parseTrunkRepositoryId({ data: [{ id: 'repo-uuid', path: 'PostHog/posthog' }] })).toBe(
      'repo-uuid'
    );
  });

  it.each([null, 'oops', {}, { data: [] }, { data: 'x' }, { data: [{ id: 7 }] }])(
    'answers null for %j',
    (raw) => {
      expect(parseTrunkRepositoryId(raw)).toBeNull();
    }
  );
});

describe('parseTrunkPullRequest', () => {
  const QUEUED = {
    id: 'pr-uuid',
    repositoryId: 'repo-uuid',
    number: 7,
    isCurrentlySubmittedToQueue: true,
    queueEntry: { id: 'entry-1', state: 'testing', stateChangedAt: '2026-10-23T12:05:00.000Z' },
  };

  it('reads the id, the queue state, the change time and the submission flag', () => {
    expect(parseTrunkPullRequest({ data: [QUEUED] }, 7)).toEqual({
      id: 'pr-uuid',
      queueState: 'testing',
      stateChangedAt: '2026-10-23T12:05:00.000Z',
      isCurrentlySubmitted: true,
    });
  });

  it('picks the row with the asked number, not the first row', () => {
    const other = { ...QUEUED, id: 'other', number: 6 };
    expect(parseTrunkPullRequest({ data: [other, QUEUED] }, 7)?.id).toBe('pr-uuid');
  });

  it('reads a PR that was never submitted (no queue entry) with no state', () => {
    const { queueEntry: _entry, ...never } = QUEUED;
    expect(parseTrunkPullRequest({ data: [{ ...never, isCurrentlySubmittedToQueue: false }] }, 7)).toEqual({
      id: 'pr-uuid',
      queueState: null,
      stateChangedAt: null,
      isCurrentlySubmitted: false,
    });
  });

  it.each([null, undefined, 'oops', 42, [], true, { data: [] }, { data: [QUEUED] }])(
    'answers null for %j when number 8 is not on the page',
    (raw) => {
      expect(parseTrunkPullRequest(raw, 8)).toBeNull();
    }
  );

  it('reads a non-boolean submission flag as unknown', () => {
    expect(
      parseTrunkPullRequest({ data: [{ ...QUEUED, isCurrentlySubmittedToQueue: 'false' }] }, 7)
        ?.isCurrentlySubmitted
    ).toBeNull();
  });
});
