import { describe, it, expect } from 'vitest';
import {
  parseTrunkEstimate,
  parseTrunkQueueState,
  parseTrunkSubmittedPullRequest,
} from '../services/trunk/parse.js';
import { getSubmittedPullRequestBody } from '../services/trunk/client.js';

/**
 * Trunk's ETA block is not in its published OpenAPI spec yet, so the parser
 * trusts nothing about it. These pin the two promises that follow: a malformed
 * answer is "no ETA" (never a throw), and an enum value we do not know is
 * `unknown` (never a guess).
 */

const AVAILABLE = {
  status: 'available',
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
    ['on_track', 'on_track'],
    ['holding', 'holding'],
    ['ON_TRACK', 'on_track'],
    ['behind', 'behind'],
    ['late', 'behind'],
    ['running_late', 'behind'],
    ['overdue', 'behind'],
    ['delayed', 'behind'],
    ['taking_longer_than_usual', 'behind'],
    ['ahead', 'unknown'],
    ['stalled', 'unknown'],
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
    'not_ready',
    'pending',
    'testing',
    'tests_passed',
    'merged',
    'failed',
    'cancelled',
    'pending_failure',
  ])('keeps the documented state %s', (state) => {
    expect(parseTrunkQueueState(state)).toBe(state);
  });

  it.each([
    ['an undocumented state', 'bisecting', 'unknown'],
    ['a different case', 'TESTING', 'unknown'],
    ['an empty string', '', null],
    ['a number', 3, null],
    ['null', null, null],
  ])('reads %s as %j', (_name, value, expected) => {
    expect(parseTrunkQueueState(value)).toBe(expected);
  });
});

describe('parseTrunkSubmittedPullRequest', () => {
  it('reads the state, the change time, the submission flag and the ETA', () => {
    expect(
      parseTrunkSubmittedPullRequest({
        id: 'entry-1',
        state: 'testing',
        stateChangedAt: '2026-10-23T12:05:00.000Z',
        isCurrentlySubmittedToQueue: true,
        prNumber: 7,
        estimatedTimeToMerge: AVAILABLE,
      })
    ).toEqual({
      queueState: 'testing',
      stateChangedAt: '2026-10-23T12:05:00.000Z',
      isCurrentlySubmitted: true,
      eta: parseTrunkEstimate(AVAILABLE),
    });
  });

  it('answers the response without an ETA block (an older Trunk) with eta null', () => {
    expect(
      parseTrunkSubmittedPullRequest({ state: 'pending', isCurrentlySubmittedToQueue: true })
    ).toEqual({ queueState: 'pending', stateChangedAt: null, isCurrentlySubmitted: true, eta: null });
  });

  it.each([null, undefined, 'oops', 42, [], true])('never throws on %j', (raw) => {
    expect(parseTrunkSubmittedPullRequest(raw)).toEqual({
      queueState: null,
      stateChangedAt: null,
      isCurrentlySubmitted: null,
      eta: null,
    });
  });

  it('reads a non-boolean submission flag as unknown', () => {
    expect(
      parseTrunkSubmittedPullRequest({ isCurrentlySubmittedToQueue: 'false' }).isCurrentlySubmitted
    ).toBeNull();
  });
});

describe('the request body', () => {
  it('matches the spec’s by-number shape and asks for the ETA', () => {
    expect(
      getSubmittedPullRequestBody({ owner: 'PostHog', repo: 'posthog', number: 123, targetBranch: 'master' })
    ).toEqual({
      repo: { host: 'github.com', owner: 'PostHog', name: 'posthog' },
      pr: { number: 123 },
      targetBranch: 'master',
      includeEstimatedTimeToMerge: true,
    });
  });
});
