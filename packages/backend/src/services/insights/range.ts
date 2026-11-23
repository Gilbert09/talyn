import { INSIGHTS_MAX_DAYS, isInsightsRangePreset, type InsightsRange } from '@talyn/shared';

const DAY_MS = 86_400_000;

export interface ResolvedRange {
  from: Date;
  to: Date;
  preset: InsightsRange['preset'];
}

/**
 * Pure: the `[from, to)` window of an Insights request, or the problem with it.
 *
 * `range=today` is the current UTC day up to now. `range=yesterday` is the
 * whole UTC day before it. `range=7d|30d` ends now. `range=period` is the
 * owner's current usage period up to now (`period` is null when billing has none: the calendar month is the
 * free plan's period, so that is the answer then). `from` + `to` is a custom
 * window of at most {@link INSIGHTS_MAX_DAYS} days. Nothing: the last 30 days.
 */
export function parseInsightsRange(
  query: { range?: unknown; from?: unknown; to?: unknown },
  now: Date,
  period: { start: Date; end: Date } | null,
): ResolvedRange | { error: string } {
  const range = query.range;
  if (range !== undefined && range !== '' && range !== 'custom') {
    if (!isInsightsRangePreset(range)) return { error: 'range must be today, yesterday, 7d, 30d or period.' };
    if (range === 'today' || range === 'yesterday') {
      const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      if (range === 'yesterday') return { from: new Date(midnight.getTime() - DAY_MS), to: midnight, preset: 'yesterday' };
      return { from: midnight, to: now.getTime() > midnight.getTime() ? now : new Date(midnight.getTime() + 1), preset: 'today' };
    }
    if (range === 'period') {
      const start = period?.start ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = period && period.end.getTime() < now.getTime() ? period.end : now;
      return { from: start, to: end.getTime() > start.getTime() ? end : new Date(start.getTime() + 1), preset: 'period' };
    }
    const days = range === '7d' ? 7 : 30;
    return { from: new Date(now.getTime() - days * DAY_MS), to: now, preset: range };
  }
  const parse = (value: unknown): Date | null | undefined => {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const from = parse(query.from);
  const to = parse(query.to);
  if (from === null || to === null) return { error: 'from and to must be ISO dates.' };
  if (from === undefined && to === undefined) {
    return { from: new Date(now.getTime() - 30 * DAY_MS), to: now, preset: '30d' };
  }
  if (from === undefined || to === undefined) return { error: 'A custom range needs both from and to.' };
  if (from.getTime() >= to.getTime()) return { error: 'from must be before to.' };
  if (to.getTime() - from.getTime() > INSIGHTS_MAX_DAYS * DAY_MS) {
    return { error: `A range covers at most ${INSIGHTS_MAX_DAYS} days.` };
  }
  return { from, to, preset: 'custom' };
}

/** Pure: every UTC day that `[from, to)` touches, as `YYYY-MM-DD`. */
export function utcDays(from: Date, to: Date): string[] {
  const out: string[] = [];
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let t = start; t < to.getTime(); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function publicRange(range: ResolvedRange): InsightsRange {
  return { from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset };
}
