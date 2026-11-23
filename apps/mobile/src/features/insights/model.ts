import {
  INSIGHTS_RANGE_PRESETS, formatBoxHoursLabel, formatInsightsDuration, formatTokenCount, formatUsd, totalTokens,
  type InsightsRangePreset, type InsightsResponseBySection, type InsightsTopRepository,
} from '@talyn/shared';

const RANGE_LABELS: Record<InsightsRangePreset, string> = {
  today: 'Today', yesterday: 'Yesterday', '7d': '7 days', '30d': '30 days', period: 'This period',
};
export const RANGE_OPTIONS: ReadonlyArray<{ value: InsightsRangePreset; label: string }> = INSIGHTS_RANGE_PRESETS.map((value) => ({
  value, label: RANGE_LABELS[value],
}));
export const DEFAULT_RANGE: InsightsRangePreset = '30d';

export type InsightsData = { [S in keyof InsightsResponseBySection]?: InsightsResponseBySection[S] };

export interface Tile { key: string; label: string; value: string | null; hint?: string }

const count = (value: number) => value.toLocaleString('en-US');

/**
 * The headline numbers, one per tile, from web's sections. A value is null
 * while its section loads or after it failed.
 */
export function insightTiles(data: InsightsData): Tile[] {
  const { compute, agents, output, speed } = data;
  const failed = agents && agents.totals.failedTurns > 0 ? `${count(agents.totals.failedTurns)} failed` : undefined;
  return [
    { key: 'box-time', label: 'Box time', value: compute ? formatBoxHoursLabel(compute.totalWsec) : null },
    { key: 'box-runs', label: 'Box runs started', value: compute ? count(compute.boxes) : null },
    { key: 'tokens', label: 'Tokens', value: agents ? formatTokenCount(totalTokens(agents.totals)) : null },
    { key: 'turns', label: 'Turns', value: agents ? count(agents.totals.turns) : null, hint: failed },
    { key: 'cost', label: 'Estimated cost', value: agents ? agents.totals.costMicros === null ? 'Not reported' : formatUsd(agents.totals.costMicros) : null,
      hint: agents ? 'At API prices' : undefined },
    { key: 'sessions', label: 'Sessions created', value: output ? count(output.sessions.created) : null },
    { key: 'merged', label: 'Pull requests merged', value: output ? count(output.sessions.pullRequestsMerged) : null },
    { key: 'first-reply', label: 'First reply', value: speed ? formatInsightsDuration(speed.firstReply.p50Ms) : null,
      hint: speed && speed.firstReply.count > 0 ? 'Median' : undefined },
  ];
}

export interface BarRow { key: string; label: string; value: string; share: number }

/** Top repositories by box time, as bars scaled to the largest. */
export function repositoryBars(rows: readonly InsightsTopRepository[]): BarRow[] {
  const top = Math.max(0, ...rows.map((row) => row.wsec));
  return rows.map((row) => ({
    key: row.repository, label: row.repository, value: formatBoxHoursLabel(row.wsec),
    share: top > 0 ? Math.round((row.wsec / top) * 100) : 0,
  }));
}

/** Box-hours per UTC day, each as a share of the busiest day. */
export function dayShares(days: readonly { date: string; wsec: number }[]): Array<{ date: string; share: number; hours: number }> {
  const top = Math.max(0, ...days.map((day) => day.wsec));
  return days.map((day) => ({ date: day.date, hours: day.wsec / 3600, share: top > 0 ? (day.wsec / top) * 100 : 0 }));
}
