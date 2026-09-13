import { describe, it, expect } from 'vitest';
import {
  cronForPreset,
  describeSchedule,
  isValidTimezone,
  nextLoopRun,
  nextLoopRuns,
  presetForCron,
  validateCron,
  DEFAULT_LOOP_SCHEDULE_FIELDS,
} from '@talyn/shared';

/**
 * The schedule arithmetic.
 *
 * This suite exists mostly for one thing: to PIN croner's daylight-saving
 * behaviour. An 02:30 daily loop has no 02:30 on the day the clocks go forward
 * and two 01:30s on the day they go back, and whatever the library does about
 * that is a product decision the moment a user's loop depends on it. A croner
 * upgrade that changes it must fail here rather than in somebody's repository
 * at two in the morning.
 */

const at = (iso: string) => new Date(iso);

describe('presets ⇄ cron', () => {
  it.each([
    ['hourly', { minute: 15 }, '15 * * * *'],
    ['daily', { minute: 30, hour: 9 }, '30 9 * * *'],
    ['weekdays', { minute: 0, hour: 17 }, '0 17 * * 1-5'],
    ['weekly', { minute: 45, hour: 8, weekday: 3 }, '45 8 * * 3'],
  ] as const)('%s renders to %s', (kind, fields, expected) => {
    expect(cronForPreset(kind, { ...DEFAULT_LOOP_SCHEDULE_FIELDS, ...fields })).toBe(expected);
  });

  it.each([
    ['15 * * * *', 'hourly'],
    ['30 9 * * *', 'daily'],
    ['0 17 * * 1-5', 'weekdays'],
    ['45 8 * * 3', 'weekly'],
    // Anything a preset cannot produce reads back as custom — the honest
    // answer, and not a failure.
    ['0 */4 * * *', 'cron'],
    ['0 9 1 * *', 'cron'],
    ['0 9 * * 1,3', 'cron'],
  ])('%s reads back as the %s preset', (cron, kind) => {
    expect(presetForCron(cron).kind).toBe(kind);
  });

  it('round-trips every preset without drift', () => {
    // The property that matters: a loop saved from a preset must re-open on
    // that preset with the same values, or editing one field silently rewrites
    // the schedule.
    for (const cron of ['15 * * * *', '30 9 * * *', '0 17 * * 1-5', '45 8 * * 3']) {
      const match = presetForCron(cron);
      expect(cronForPreset(match.kind, match.fields)).toBe(cron);
    }
  });
});

describe('validateCron', () => {
  it('accepts a five-field expression', () => {
    expect(validateCron('0 9 * * *')).toEqual({ ok: true });
  });

  it('refuses a six-field expression by name', () => {
    // croner accepts seconds; Talyn does not. Every firing writes a durable row
    // and creates a cloud task, so a per-second schedule promises a cadence the
    // rest of the system cannot keep.
    const result = validateCron('0 0 9 * * *');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('five fields');
  });

  it.each(['', 'not a cron', '0 9 * *', '99 9 * * *'])('refuses %j', (expr) => {
    expect(validateCron(expr).ok).toBe(false);
  });

  it('refuses a schedule with no future runs', () => {
    // 30 February. It parses, and it never happens.
    const result = validateCron('0 0 30 2 *');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no future runs');
  });

  it('accepts an annual schedule, however far away the next one is', () => {
    // 29 February can be three years out. An earlier version capped how distant
    // the next run could be, which refused exactly this — the longest
    // legitimate cron period there is.
    expect(validateCron('0 9 29 2 *').ok).toBe(true);
    expect(validateCron('0 9 1 1 *').ok).toBe(true);
  });
});

describe('nextLoopRun', () => {
  it('is strictly after the instant it is given', () => {
    // The claim key is the occurrence instant, so an advance that returned the
    // same instant would re-claim the firing it just did and wedge the loop.
    const from = at('2026-09-14T08:00:00Z');
    const next = nextLoopRun('0 9 * * *', 'Europe/London', from);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it('follows the loop’s timezone, not the machine’s', () => {
    // 09:00 in London during BST is 08:00Z; the same expression in Tokyo is
    // 00:00Z. A scheduler that used the host's zone would fire both at once.
    const from = at('2026-09-14T00:00:00Z');
    expect(nextLoopRun('0 9 * * *', 'Europe/London', from)!.toISOString()).toBe(
      '2026-09-14T08:00:00.000Z'
    );
    // Tokyo's 09:00 on the 14th IS the `from` instant, and nextRun is strictly
    // after — so the answer is the 15th. That strictness is load-bearing: the
    // claim key is the occurrence, so an advance that returned its own input
    // would re-claim the firing it just did and wedge the loop.
    expect(nextLoopRun('0 9 * * *', 'Asia/Tokyo', from)!.toISOString()).toBe(
      '2026-09-15T00:00:00.000Z'
    );
  });

  it('answers null for a schedule that never fires again', () => {
    expect(nextLoopRun('0 0 30 2 *', 'UTC', at('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('answers null rather than throwing on a bad expression', () => {
    // The scheduler calls this on stored data. A throw here would take down a
    // whole tick over one corrupt row.
    expect(nextLoopRun('nonsense', 'UTC', new Date())).toBeNull();
  });

  describe('daylight saving', () => {
    // US clocks go forward at 02:00 on 2026-03-08 and back at 02:00 on
    // 2026-11-01. A 02:30 daily loop meets both edges.
    const TZ = 'America/New_York';

    it('still fires exactly once on the day 02:30 does not exist', () => {
      const runs = nextLoopRuns('30 2 * * *', TZ, at('2026-03-06T12:00:00Z'), 4);
      expect(runs.map((d) => d.toISOString())).toEqual([
        '2026-03-07T07:30:00.000Z', // 02:30 EST
        '2026-03-08T07:30:00.000Z', // the spring-forward day — one firing, shifted
        '2026-03-09T06:30:00.000Z', // 02:30 EDT
        '2026-03-10T06:30:00.000Z',
      ]);
      // The property that actually matters, whatever instant the library picks:
      // one firing that day, never zero and never two.
      const onTheDay = runs.filter((d) => d.toISOString().startsWith('2026-03-08'));
      expect(onTheDay).toHaveLength(1);
    });

    it('fires exactly once on the day 01:30 happens twice', () => {
      const runs = nextLoopRuns('30 1 * * *', TZ, at('2026-10-30T12:00:00Z'), 4);
      const onTheDay = runs.filter((d) => d.toISOString().startsWith('2026-11-01'));
      expect(onTheDay).toHaveLength(1);
    });

    it('keeps a 09:00 loop at 09:00 local across the change', () => {
      // The user-visible promise of storing a timezone rather than an offset.
      const runs = nextLoopRuns('0 9 * * *', TZ, at('2026-03-06T12:00:00Z'), 4);
      for (const run of runs) {
        const local = new Intl.DateTimeFormat('en-GB', {
          timeZone: TZ,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(run);
        expect(local).toBe('09:00');
      }
    });
  });
});

describe('isValidTimezone', () => {
  it.each(['UTC', 'Europe/London', 'America/New_York', 'Asia/Tokyo'])('accepts %s', (tz) => {
    expect(isValidTimezone(tz)).toBe(true);
  });

  it.each(['', 'Mars/Olympus', 'GMT+1000000', 'not a zone'])('refuses %j', (tz) => {
    expect(isValidTimezone(tz)).toBe(false);
  });
});

describe('describeSchedule', () => {
  it.each([
    ['15 * * * *', 'Every hour at :15'],
    ['30 9 * * *', 'Every day at 09:30'],
    ['0 17 * * 1-5', 'Weekdays at 17:00'],
    ['45 8 * * 3', 'Every Wednesday at 08:45'],
    ['0 */4 * * *', 'Cron: 0 */4 * * *'],
  ])('%s reads as %s', (cron, expected) => {
    expect(describeSchedule(cron, 'Europe/London')).toBe(`${expected} (Europe/London)`);
  });
});
