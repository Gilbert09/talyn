import {
  INSIGHTS_MAX_DAYS,
  type Features,
  type InsightsQuery,
  type InsightsRangePreset,
  type UsageSubjectKind,
} from '@talyn/shared';

/**
 * Pure helpers for the Insights page: the flag, the range picker and the
 * labels. Nothing here talks to the backend.
 */

/** Three-state like `loopsOffered`: null features (still loading) offers nothing. */
export function insightsOffered(features: Pick<Features, 'usageInsights'> | null | undefined): boolean {
  return features?.usageInsights === true;
}

/** The applied range. Custom dates are `YYYY-MM-DD` (UTC days), both included. */
export type InsightsRangeChoice =
  | { preset: InsightsRangePreset }
  | { preset: 'custom'; from: string; to: string };

export const DEFAULT_INSIGHTS_RANGE: InsightsRangeChoice = { preset: '30d' };

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateToMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  // V8 rolls 2026-02-30 over to March; the round trip refuses it.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return ms;
}

/** The inline message for a custom range, or null when the backend will accept it. */
export function validateCustomRange(from: string, to: string): string | null {
  const fromMs = dateToMs(from);
  const toMs = dateToMs(to);
  if (fromMs === null || toMs === null) return 'Pick a start date and an end date.';
  if (fromMs > toMs) return 'The start date must be on or before the end date.';
  if ((toMs - fromMs) / DAY_MS + 1 > INSIGHTS_MAX_DAYS) return `Pick a range of ${INSIGHTS_MAX_DAYS} days or less.`;
  return null;
}

/** The range part of an insights query. */
export function insightsRangeQuery(range: InsightsRangeChoice): Omit<InsightsQuery, 'workspaceId'> {
  if (range.preset === 'custom') {
    // The end day is included: the backend's `to` is the midnight after it.
    const toMs = dateToMs(range.to);
    const to = toMs === null ? `${range.to}T00:00:00.000Z` : new Date(toMs + DAY_MS).toISOString();
    return { from: `${range.from}T00:00:00.000Z`, to };
  }
  return { range: range.preset };
}

/** A stable string for a range, to tell a stale response from the current one. */
export function insightsRangeKey(range: InsightsRangeChoice): string {
  return range.preset === 'custom' ? `custom:${range.from}:${range.to}` : range.preset;
}

/** `YYYY-MM-DD` of a UTC day, `offsetDays` from `now`. */
export function utcDateString(now: Date, offsetDays = 0): string {
  return new Date(now.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

export const INSIGHTS_KIND_LABELS: Record<UsageSubjectKind, string> = {
  workbench: 'Sessions',
  task: 'Tasks',
  review_unit: 'Code review',
};

export function agentLabel(agent: string): string {
  if (agent === 'claude') return 'Claude';
  if (agent === 'codex') return 'Codex';
  return agent;
}

export function modelLabel(model: string): string {
  return model === 'unknown' ? 'Default model' : model;
}

export function fixRunSourceLabel(source: string): string {
  switch (source) {
    case 'merge_queue':
      return 'Merge queue';
    case 'auto_keep':
      return 'Keep green';
    case 'code_review':
      return 'Code review fixes';
    default:
      return 'Other';
  }
}

/** Fix runs with the unknown sources added into one "Other" row. */
export function groupFixRuns(rows: { source: string; count: number }[]): { label: string; count: number }[] {
  const byLabel = new Map<string, number>();
  for (const row of rows) {
    const label = fixRunSourceLabel(row.source);
    byLabel.set(label, (byLabel.get(label) ?? 0) + row.count);
  }
  return [...byLabel.entries()].map(([label, count]) => ({ label, count }));
}

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

export const FINDING_SEVERITY_LABELS: Record<string, string> = {
  blocker: 'Blocker',
  major: 'Major',
  minor: 'Minor',
  nit: 'Nit',
};

export const BOX_START_CAUSE_LABELS: Record<string, string> = {
  new: 'New box',
  move: 'Moved to another host',
  lost: 'Replaced a lost box',
  restore: 'Restored',
  unknown: 'Unknown',
};

export const WAKE_SOURCE_LABELS: Record<string, string> = {
  host: 'From the host',
  storage: 'From storage',
};
