import { fullTimeLabel, newestEventAt, relativeTimeLabel } from '../renderer/lib/relativeTime';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('relativeTimeLabel', () => {
  it.each([
    ['the same instant', 0, 'a few seconds ago'],
    ['44 seconds', 44 * SECOND, 'a few seconds ago'],
    ['45 seconds', 45 * SECOND, 'a minute ago'],
    ['89 seconds', 89 * SECOND, 'a minute ago'],
    ['90 seconds', 90 * SECOND, '2 minutes ago'],
    ['44 minutes', 44 * MINUTE, '44 minutes ago'],
    ['45 minutes', 45 * MINUTE, 'an hour ago'],
    ['89 minutes', 89 * MINUTE, 'an hour ago'],
    ['90 minutes', 90 * MINUTE, '2 hours ago'],
    ['21 hours', 21 * HOUR, '21 hours ago'],
    ['22 hours', 22 * HOUR, 'yesterday'],
    ['35 hours', 35 * HOUR, 'yesterday'],
    ['36 hours', 36 * HOUR, '2 days ago'],
    ['25 days', 25 * DAY, '25 days ago'],
    ['26 days', 26 * DAY, 'a month ago'],
    ['45 days', 45 * DAY, '2 months ago'],
    ['319 days', 319 * DAY, '11 months ago'],
    ['320 days', 320 * DAY, 'a year ago'],
    ['548 days', 548 * DAY, '2 years ago'],
  ])('%s ago reads "%s"', (_name, ms, expected) => {
    expect(relativeTimeLabel(ago(ms), NOW)).toBe(expected);
  });

  it('reads a time in the future (clock skew) as a few seconds ago', () => {
    expect(relativeTimeLabel(ago(-5 * MINUTE), NOW)).toBe('a few seconds ago');
  });

  it.each([[''], ['not a date']])('answers an empty label for %j', (iso) => {
    expect(relativeTimeLabel(iso, NOW)).toBe('');
    expect(fullTimeLabel(iso)).toBe('');
  });

  it('gives the full date and year in the tooltip', () => {
    expect(fullTimeLabel('2026-11-08T12:00:00.000Z')).toMatch(/2026/);
  });
});

describe('newestEventAt', () => {
  it.each([
    ['no list', undefined, null],
    ['an empty list', [], null],
    ['no event with a time', [{}, {}], null],
    ['the last event with a time', [{ createdAt: 'a' }, { createdAt: 'b' }], 'b'],
    ['skips newer events without a time', [{ createdAt: 'a' }, {}], 'a'],
  ])('%s', (_name, events, expected) => {
    expect(newestEventAt(events)).toBe(expected);
  });
});
