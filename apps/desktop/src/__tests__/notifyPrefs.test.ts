import {
  getMergeBlockedNotifyEnabled,
  setMergeBlockedNotifyEnabled,
} from '../renderer/hooks/useApi';

const KEY = 'fastowl:notify:mergeBlocked';

describe('merge-blocked notification preference', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to on when unset', () => {
    expect(getMergeBlockedNotifyEnabled()).toBe(true);
  });

  it('round-trips an explicit disable/enable', () => {
    setMergeBlockedNotifyEnabled(false);
    expect(localStorage.getItem(KEY)).toBe('false');
    expect(getMergeBlockedNotifyEnabled()).toBe(false);

    setMergeBlockedNotifyEnabled(true);
    expect(getMergeBlockedNotifyEnabled()).toBe(true);
  });
});
