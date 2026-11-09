import { longTime, relativeTimeLabel, shortTime } from '../lib/time';

// Local times, so calendar-day rules hold in any timezone the suite runs in.
const now = new Date(2026, 10, 9, 12, 0, 0).getTime();
const at = (...parts: [number, number, number, number?, number?]) => new Date(...(parts as [number, number, number, number, number])).toISOString();
const ago = (ms: number) => new Date(now - ms).toISOString();
const MINUTE = 60_000; const HOUR = 60 * MINUTE;

describe('shortTime', () => {
  it.each([
    ['just now', ago(10_000), 'now'],
    ['a future time from clock skew', ago(-5 * MINUTE), 'now'],
    ['minutes', ago(5 * MINUTE), '5m'],
    ['59 minutes', ago(59 * MINUTE), '59m'],
    ['hours', ago(2 * HOUR), '2h'],
    ['23 hours', ago(23 * HOUR), '23h'],
    ['yesterday by calendar', at(2026, 10, 8, 9, 0), 'yesterday'],
    ['two days', at(2026, 10, 7, 12, 0), '2d'],
    ['six days', at(2026, 10, 3, 12, 0), '6d'],
    ['a week, same year', at(2026, 10, 2, 12, 0), '2 Nov'],
    ['earlier this year', at(2026, 0, 15, 8, 0), '15 Jan'],
    ['another year', at(2025, 11, 31, 8, 0), '31 Dec 2025'],
  ])('labels %s', (_name, iso, expected) => expect(shortTime(iso, now)).toBe(expected));
  it.each([null, undefined, '', 'not a date'])('is empty for %p', (value) => expect(shortTime(value, now)).toBe(''));
});

describe('relativeTimeLabel', () => {
  it.each([
    [10_000, 'a few seconds ago'], [60_000, 'a minute ago'], [5 * MINUTE, '5 minutes ago'], [HOUR, 'an hour ago'],
    [3 * HOUR, '3 hours ago'], [30 * HOUR, 'yesterday'], [3 * 24 * HOUR, '3 days ago'], [40 * 24 * HOUR, 'a month ago'],
    [100 * 24 * HOUR, '3 months ago'], [400 * 24 * HOUR, 'a year ago'], [800 * 24 * HOUR, '2 years ago'],
  ])('labels %i ms ago as %s', (ms, expected) => expect(relativeTimeLabel(ago(ms), now)).toBe(expected));
  it('is empty for an invalid time', () => expect(relativeTimeLabel('nope', now)).toBe(''));
});

describe('longTime', () => {
  it.each([
    [at(2026, 10, 3, 17, 1), '3 Nov 2026, 17:01'],
    [at(2026, 0, 9, 8, 5), '9 Jan 2026, 08:05'],
  ])('formats %s', (iso, expected) => expect(longTime(iso)).toBe(expected));
  it('is empty for an invalid time', () => expect(longTime(null)).toBe(''));
});
