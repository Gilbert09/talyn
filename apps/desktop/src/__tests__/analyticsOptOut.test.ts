/**
 * The analytics opt-out mirror: the Settings toggle reads/writes an
 * app-owned localStorage flag so it renders correctly even before (or
 * without) PostHog initialising. posthog-js itself is mocked (see
 * .erb/mocks/posthogJsMock.js) — these tests pin the persistence contract.
 */
import {
  getAnalyticsOptOut,
  setAnalyticsOptOut,
} from '../renderer/lib/analytics';

const OPT_OUT_KEY = 'fastowl-analytics-opt-out';

describe('analytics opt-out persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to opted in (sharing on)', () => {
    expect(getAnalyticsOptOut()).toBe(false);
  });

  it.each([
    [true, 'true'],
    [false, 'false'],
  ])('persists %s to localStorage', (optedOut, stored) => {
    setAnalyticsOptOut(optedOut);
    expect(getAnalyticsOptOut()).toBe(optedOut);
    expect(localStorage.getItem(OPT_OUT_KEY)).toBe(stored);
  });

  it('round-trips out and back in', () => {
    setAnalyticsOptOut(true);
    expect(getAnalyticsOptOut()).toBe(true);
    setAnalyticsOptOut(false);
    expect(getAnalyticsOptOut()).toBe(false);
  });

  it('treats junk stored values as opted in', () => {
    localStorage.setItem(OPT_OUT_KEY, 'banana');
    expect(getAnalyticsOptOut()).toBe(false);
  });
});
