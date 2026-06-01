/**
 * The cache registers a `pull_request:updated` WS handler at module load,
 * so we mock the api module to capture that handler and drive it directly.
 */
let wsHandler: ((payload: unknown) => void) | null = null;
jest.mock('../renderer/lib/api', () => ({
  api: {
    ws: {
      on: (_event: string, fn: (payload: unknown) => void) => {
        wsHandler = fn;
        return () => {};
      },
    },
  },
}));

import {
  getCachedPRStatus,
  prime,
  subscribePRStatus,
  type PRStatus,
} from '../renderer/lib/prSummaryCache';
import type { PRSummaryShape } from '../renderer/lib/api';

const summary = (reason: string): PRSummaryShape =>
  ({ blockingReason: reason, checks: {} } as unknown as PRSummaryShape);

const status = (reason: string, state: PRStatus['state'] = 'open'): PRStatus => ({
  summary: summary(reason),
  state,
});

describe('prSummaryCache', () => {
  it('returns undefined for an unseen PR and the last value after prime()', () => {
    expect(getCachedPRStatus('new-pr')).toBeUndefined();
    prime('pr-1', status('clean'));
    expect(getCachedPRStatus('pr-1')).toEqual(status('clean'));
    prime('pr-1', status('conflicts', 'closed'));
    expect(getCachedPRStatus('pr-1')).toEqual(status('conflicts', 'closed'));
  });

  it('notifies only subscribers for the matching id', () => {
    const onA = jest.fn();
    const onB = jest.fn();
    const offA = subscribePRStatus('pr-a', onA);
    subscribePRStatus('pr-b', onB);

    prime('pr-a', status('clean'));
    expect(onA).toHaveBeenCalledWith(status('clean'));
    expect(onB).not.toHaveBeenCalled();

    offA();
    prime('pr-a', status('conflicts'));
    expect(onA).toHaveBeenCalledTimes(1); // unsubscribed
  });

  it('warms the cache from pull_request:updated WS events', () => {
    expect(wsHandler).toBeTruthy();
    const onC = jest.fn();
    subscribePRStatus('pr-c', onC);

    wsHandler!({ id: 'pr-c', state: 'merged', lastSummary: summary('clean') });
    expect(getCachedPRStatus('pr-c')).toEqual(status('clean', 'merged'));
    expect(onC).toHaveBeenCalledWith(status('clean', 'merged'));
  });

  it('ignores WS events with no summary, and falls back to the cached state', () => {
    wsHandler!({ id: 'pr-d' }); // no lastSummary → ignored
    expect(getCachedPRStatus('pr-d')).toBeUndefined();

    prime('pr-d', status('clean', 'open'));
    // A later event without an explicit state keeps the prior state.
    wsHandler!({ id: 'pr-d', lastSummary: summary('conflicts') });
    expect(getCachedPRStatus('pr-d')).toEqual(status('conflicts', 'open'));
  });
});
