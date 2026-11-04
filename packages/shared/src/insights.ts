/**
 * Insights: a workspace's usage analytics (compute, agent tokens, output,
 * speed, top lists). The contract of `GET /api/v1/insights/:section`.
 *
 * Every section answers for one workspace and one `[from, to)` window. Days are
 * UTC, like the billing usage page. Token counts and cost come from the agent's
 * own result events, stored once per turn in `workbench_turn_usage`; the cost
 * is the agent's estimate at API prices. The workspace's own Claude or Codex
 * subscription pays for the tokens, not Talyn.
 */

import type { SandboxSize } from './sandboxSize.js';
import type { UsageSubjectKind, PlanTier } from './pricing.js';

export const INSIGHTS_SECTIONS = ['compute', 'agents', 'output', 'speed', 'top'] as const;
export type InsightsSection = (typeof INSIGHTS_SECTIONS)[number];

export function isInsightsSection(value: unknown): value is InsightsSection {
  return typeof value === 'string' && (INSIGHTS_SECTIONS as readonly string[]).includes(value);
}

/** The presets the range picker offers. `period` is the owner's current usage period. */
export const INSIGHTS_RANGE_PRESETS = ['7d', '30d', 'period'] as const;
export type InsightsRangePreset = (typeof INSIGHTS_RANGE_PRESETS)[number];

export function isInsightsRangePreset(value: unknown): value is InsightsRangePreset {
  return typeof value === 'string' && (INSIGHTS_RANGE_PRESETS as readonly string[]).includes(value);
}

export const INSIGHTS_RANGE_LABELS: Record<InsightsRangePreset | 'custom', string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  period: 'This billing period',
  custom: 'Custom',
};

/** Longest window one request may cover. The day series has one entry per day. */
export const INSIGHTS_MAX_DAYS = 366;

/** Rows in each top list. */
export const INSIGHTS_TOP_LIMIT = 10;

/** The resolved window of a response. ISO instants, `to` exclusive. */
export interface InsightsRange {
  from: string;
  to: string;
  preset: InsightsRangePreset | 'custom';
}

/** Query of every section: a preset, or `from` + `to` for a custom window. */
export interface InsightsQuery {
  workspaceId: string;
  range?: InsightsRangePreset;
  from?: string;
  to?: string;
}

export interface InsightsTokenCounts {
  /** Input tokens that were not read from the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** p50 / p90 of a set of durations. Null when there are no samples. */
export interface InsightsPercentiles {
  count: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

// ---------- Compute ----------

export interface InsightsComputeDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  /** Weighted seconds: running seconds times the box size's weight. 3600 = one box-hour. */
  wsec: number;
}

export interface InsightsComputeResponse {
  range: InsightsRange;
  /** Box time in this workspace in the window, weighted by size. */
  totalWsec: number;
  /** Box runs that started in the window. */
  boxes: number;
  days: InsightsComputeDay[];
  bySize: { size: SandboxSize; wsec: number; boxes: number }[];
  byKind: { kind: UsageSubjectKind; wsec: number; boxes: number }[];
  /**
   * The owner's current usage period, across ALL their workspaces (the plan
   * is per account). Null when billing has no period for the owner.
   */
  period: {
    tier: PlanTier;
    periodStart: string;
    periodEnd: string;
    includedWsec: number;
    usedWsec: number;
    creditMicrosUsed: number;
  } | null;
}

// ---------- Agents ----------

export interface InsightsModelUsage extends InsightsTokenCounts {
  agent: string;
  model: string;
  /** Turns where this model was the turn's main model. */
  turns: number;
  /** Sum of the agent's own cost estimates. Null when no turn reported one. */
  costMicros: number | null;
}

export interface InsightsAgentDay extends InsightsTokenCounts {
  date: string;
  turns: number;
}

export interface InsightsAgentsResponse {
  range: InsightsRange;
  totals: InsightsTokenCounts & {
    turns: number;
    failedTurns: number;
    /** Agent steps (model calls) the agents reported. Claude only. */
    agentSteps: number;
    /** Sum of cost estimates. Null when no turn in the window reported one. */
    costMicros: number | null;
    /** Turns with a cost estimate. Codex does not report one. */
    turnsWithCost: number;
  };
  byAgent: (InsightsTokenCounts & { agent: string; turns: number; costMicros: number | null })[];
  byModel: InsightsModelUsage[];
  days: InsightsAgentDay[];
  turnDuration: InsightsPercentiles;
}

// ---------- Output ----------

export interface InsightsOutputResponse {
  range: InsightsRange;
  sessions: {
    created: number;
    /** Sessions that a pull request was linked to in the window. */
    withPullRequest: number;
    /** Of those pull requests, the ones that merged in the window. */
    pullRequestsMerged: number;
  };
  tasks: {
    created: number;
    completed: number;
    failed: number;
    /** Tasks that linked a pull request. */
    withPullRequest: number;
  };
  /** Fix runs by what started them: merge_queue, auto_keep, code_review, other. */
  fixRuns: { source: string; count: number }[];
  mergeQueue: { landed: number };
  codeReview: {
    /** Review cycles that started in the window. */
    reviews: number;
    /** Findings first seen in the window that the judge did not reject, by severity. */
    findings: { severity: string; count: number }[];
  };
}

// ---------- Speed ----------

export interface InsightsSpeedResponse {
  range: InsightsRange;
  /** From the create request to a box that has run its setup. */
  boxStart: InsightsPercentiles & { byCause: (InsightsPercentiles & { cause: string })[] };
  /** Resume of a sleeping box, by where it woke from (host or storage). */
  wake: InsightsPercentiles & { bySource: (InsightsPercentiles & { source: string })[] };
  /** From a sent message to the agent's first reply, every turn. */
  firstReply: InsightsPercentiles;
  /** The same, for the first message of each session only. Includes the box start. */
  firstReplyNewSession: InsightsPercentiles;
  /** From the queued message to the agent process start. Sandbox sessions only. */
  turnStart: InsightsPercentiles;
}

// ---------- Top lists ----------

export interface InsightsTopRepository {
  repository: string;
  wsec: number;
  tokens: number;
}

export interface InsightsTopSession {
  workbenchId: string;
  /** The session's title or name. Null for a session that was deleted. */
  title: string | null;
  repository: string | null;
  archived: boolean;
  wsec: number;
  tokens: number;
}

export interface InsightsTopResponse {
  range: InsightsRange;
  repositoriesByHours: InsightsTopRepository[];
  repositoriesByTokens: InsightsTopRepository[];
  sessionsByHours: InsightsTopSession[];
  sessionsByTokens: InsightsTopSession[];
}

export interface InsightsResponseBySection {
  compute: InsightsComputeResponse;
  agents: InsightsAgentsResponse;
  output: InsightsOutputResponse;
  speed: InsightsSpeedResponse;
  top: InsightsTopResponse;
}

/** Every token kind, added up. What the top lists rank by. */
export function totalTokens(counts: InsightsTokenCounts): number {
  return counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens;
}

/** `1234` → `1.2K`, `5600000` → `5.6M`. */
export function formatTokenCount(value: number): string {
  const abs = Math.abs(value);
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/** A duration for a speed tile: `850 ms`, `12.4 s`, `3.2 min`. `No data` for null. */
export function formatInsightsDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'No data';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))} s`;
  if (ms < 3_600_000) return `${Number((ms / 60_000).toFixed(1))} min`;
  return `${Number((ms / 3_600_000).toFixed(1))} h`;
}
