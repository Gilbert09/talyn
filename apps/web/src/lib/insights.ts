import {
  INSIGHTS_MAX_DAYS,
  SANDBOX_SIZES,
  type Features,
  type InsightsQuery,
  type InsightsRangePreset,
  type SandboxSize,
  type UsageSubjectKind,
} from '@talyn/shared';

/** Draw the Insights nav entry and page only when the account has the flag. */
export function insightsOffered(features: Pick<Features, 'usageInsights'> | null | undefined): boolean {
  return features?.usageInsights === true;
}

/**
 * What the range picker holds. A custom range is two whole UTC days, both
 * included: `to` is sent as the midnight after it, because the API's `to` is
 * exclusive and a person who picks today as the end expects today in it.
 */
export type InsightsRangeChoice =
  | { kind: 'preset'; preset: InsightsRangePreset }
  | { kind: 'custom'; from: string; to: string };

export const DEFAULT_INSIGHTS_RANGE: InsightsRangeChoice = { kind: 'preset', preset: '30d' };

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcMidnight(date: string): number | null {
  if (!DATE_RE.test(date)) return null;
  const t = Date.parse(`${date}T00:00:00.000Z`);
  // A round trip refuses a day the month does not have (2026-02-30).
  return Number.isNaN(t) || utcDateString(t) !== date ? null : t;
}

/** `YYYY-MM-DD` of an instant, in UTC. */
export function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The problem with a custom range, or null when it can be sent. */
export function customRangeError(from: string, to: string): string | null {
  const start = utcMidnight(from);
  const end = utcMidnight(to);
  if (start === null || end === null) return 'Pick a start and an end date.';
  if (start > end) return 'The start date must be on or before the end date.';
  const days = (end - start) / DAY_MS + 1;
  if (days > INSIGHTS_MAX_DAYS) return `A range can cover at most ${INSIGHTS_MAX_DAYS} days.`;
  return null;
}

/** The query fields of a range. Null for a custom range that is not valid. */
export function rangeQuery(choice: InsightsRangeChoice): Omit<InsightsQuery, 'workspaceId'> | null {
  if (choice.kind === 'preset') return { range: choice.preset };
  if (customRangeError(choice.from, choice.to)) return null;
  const start = utcMidnight(choice.from)!;
  const end = utcMidnight(choice.to)! + DAY_MS;
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

/** A stable key for a range, for re-fetching and for analytics de-duplication. */
export function rangeKey(choice: InsightsRangeChoice): string {
  return choice.kind === 'preset' ? choice.preset : `custom:${choice.from}:${choice.to}`;
}

/** The `range` property of `insights_viewed`: the preset, or `custom`. */
export function analyticsRange(choice: InsightsRangeChoice): InsightsRangePreset | 'custom' {
  return choice.kind === 'preset' ? choice.preset : 'custom';
}

export const INSIGHTS_KIND_LABELS: Record<UsageSubjectKind, string> = {
  workbench: 'Sessions',
  task: 'Tasks',
  review_unit: 'Code review',
};

export function kindLabel(kind: string): string {
  return INSIGHTS_KIND_LABELS[kind as UsageSubjectKind] ?? kind;
}

export function sizeLabel(size: SandboxSize | string): string {
  return SANDBOX_SIZES[size as SandboxSize]?.label.split(' · ')[0] ?? size;
}

export function agentLabel(agent: string): string {
  if (agent === 'claude') return 'Claude';
  if (agent === 'codex') return 'Codex';
  return agent;
}

export function modelLabel(model: string): string {
  return model === 'unknown' ? 'Default model' : model;
}

export function fixSourceLabel(source: string): string {
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

/** Fix runs with every unknown source folded into one "Other" row. */
export function groupFixRuns(rows: readonly { source: string; count: number }[]): { label: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const label = fixSourceLabel(row.source);
    totals.set(label, (totals.get(label) ?? 0) + row.count);
  }
  return [...totals].map(([label, count]) => ({ label, count }));
}

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

export const FINDING_SEVERITY_LABELS: Record<(typeof FINDING_SEVERITIES)[number], string> = {
  blocker: 'Blocker',
  major: 'Major',
  minor: 'Minor',
  nit: 'Nit',
};

export function boxStartCauseLabel(cause: string): string {
  switch (cause) {
    case 'new':
      return 'New box';
    case 'move':
      return 'Moved to another host';
    case 'lost':
      return 'Replaced a lost box';
    case 'restore':
      return 'Restored';
    default:
      return 'Unknown';
  }
}

export function wakeSourceLabel(source: string): string {
  if (source === 'host') return 'From the host';
  if (source === 'storage') return 'From storage';
  return 'Unknown';
}
