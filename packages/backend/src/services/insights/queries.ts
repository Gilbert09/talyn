import { sql, type SQL } from 'drizzle-orm';
import {
  INSIGHTS_TOP_LIMIT,
  type InsightsAgentDay,
  type InsightsAgentsResponse,
  type InsightsComputeResponse,
  type InsightsModelUsage,
  type InsightsOutputResponse,
  type InsightsPercentiles,
  type InsightsSpeedResponse,
  type InsightsTokenCounts,
  type InsightsTopRepository,
  type InsightsTopResponse,
  type InsightsTopSession,
  type SandboxSize,
  type UsageSubjectKind,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { publicRange, utcDays, type ResolvedRange } from './range.js';

/**
 * Insights' aggregations. Every query:
 *  - reads only small columns: the compact Insights tables, the usage ledger,
 *    and scalar columns of tasks, workbenches, pull requests, the merge queue
 *    and code review. Never `workbench_events`, `tasks.transcript`,
 *    `pull_requests.last_summary`/`body` or `workbenches.settings`
 *    (`insightsEgress.test.ts` holds this);
 *  - is scoped to ONE workspace (and its owner, for the usage ledger);
 *  - sends dates as ISO strings cast in SQL, never a `Date` in a raw fragment
 *    (see `loopQueryParams.test.ts` for why).
 */

export interface InsightsScope extends ResolvedRange {
  ownerId: string;
  workspaceId: string;
}

const db = () => getPoolDbClient();

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

async function run<T>(query: SQL): Promise<T[]> {
  return rowsOf<T>(await db().execute(query));
}

const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;
const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));
const ms = (value: unknown): number | null => (value === null || value === undefined ? null : Math.round(num(value)));

const PERCENTILES = (column: SQL) => sql`
  count(${column}) AS n,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${column}) AS p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY ${column}) AS p90`;

interface PercentileRow { n: unknown; p50: unknown; p90: unknown }
const percentiles = (row: PercentileRow | undefined): InsightsPercentiles => ({
  count: num(row?.n),
  p50Ms: num(row?.n) > 0 ? ms(row?.p50) : null,
  p90Ms: num(row?.n) > 0 ? ms(row?.p90) : null,
});

const TOKEN_SUMS = sql`
  COALESCE(sum(input_tokens), 0) AS input_tokens,
  COALESCE(sum(output_tokens), 0) AS output_tokens,
  COALESCE(sum(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(sum(cache_write_tokens), 0) AS cache_write_tokens`;

interface TokenRow { input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown }
const tokens = (row: TokenRow): InsightsTokenCounts => ({
  inputTokens: num(row.input_tokens),
  outputTokens: num(row.output_tokens),
  cacheReadTokens: num(row.cache_read_tokens),
  cacheWriteTokens: num(row.cache_write_tokens),
});

const TOKEN_TOTAL = sql`(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)`;

// ---------- Compute ----------

const intervalScope = (s: InsightsScope) => sql`
  owner_id = ${s.ownerId} AND workspace_id = ${s.workspaceId}
  AND started_at >= ${ts(s.from)} AND started_at < ${ts(s.to)}`;

/** Weighted seconds per UTC start day. Same day rule as the billing usage page. */
export function computeDaysSql(s: InsightsScope): SQL {
  return sql`
    SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, COALESCE(sum(billed_wsec), 0) AS wsec
    FROM usage_intervals WHERE ${intervalScope(s)}
    GROUP BY 1`;
}

export function computeBreakdownSql(s: InsightsScope): SQL {
  return sql`
    SELECT size, subject_kind AS kind, COALESCE(sum(billed_wsec), 0) AS wsec,
      count(*) FILTER (WHERE end_reason IS DISTINCT FROM 'resize') AS boxes
    FROM usage_intervals WHERE ${intervalScope(s)}
    GROUP BY size, subject_kind`;
}

export async function loadCompute(
  s: InsightsScope,
  period: InsightsComputeResponse['period'],
): Promise<InsightsComputeResponse> {
  const [dayRows, breakdown] = await Promise.all([
    run<{ date: string; wsec: unknown }>(computeDaysSql(s)),
    run<{ size: string; kind: string; wsec: unknown; boxes: unknown }>(computeBreakdownSql(s)),
  ]);
  const byDay = new Map(dayRows.map((r) => [r.date, num(r.wsec)]));
  const bySize = new Map<string, { wsec: number; boxes: number }>();
  const byKind = new Map<string, { wsec: number; boxes: number }>();
  let totalWsec = 0;
  let boxes = 0;
  for (const row of breakdown) {
    const wsec = num(row.wsec);
    const n = num(row.boxes);
    totalWsec += wsec;
    boxes += n;
    for (const [map, key] of [[bySize, row.size], [byKind, row.kind]] as const) {
      const prev = map.get(key) ?? { wsec: 0, boxes: 0 };
      map.set(key, { wsec: prev.wsec + wsec, boxes: prev.boxes + n });
    }
  }
  return {
    range: publicRange(s),
    totalWsec,
    boxes,
    days: utcDays(s.from, s.to).map((date) => ({ date, wsec: byDay.get(date) ?? 0 })),
    bySize: [...bySize].map(([size, v]) => ({ size: size as SandboxSize, ...v })).sort((a, b) => b.wsec - a.wsec),
    byKind: [...byKind].map(([kind, v]) => ({ kind: kind as UsageSubjectKind, ...v })).sort((a, b) => b.wsec - a.wsec),
    period,
  };
}

// ---------- Agents ----------

const usageScope = (s: InsightsScope) => sql`
  workspace_id = ${s.workspaceId} AND ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)}`;

export function agentsByModelSql(s: InsightsScope): SQL {
  return sql`
    SELECT agent, model, ${TOKEN_SUMS},
      count(*) FILTER (WHERE is_primary) AS turns,
      count(*) FILTER (WHERE is_primary AND is_error) AS failed_turns,
      count(*) FILTER (WHERE is_primary AND cost_estimate_micros IS NOT NULL) AS turns_with_cost,
      sum(cost_estimate_micros) AS cost_micros,
      COALESCE(sum(agent_steps), 0) AS agent_steps
    FROM workbench_turn_usage WHERE ${usageScope(s)}
    GROUP BY agent, model`;
}

export function agentsDaysSql(s: InsightsScope): SQL {
  return sql`
    SELECT to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, ${TOKEN_SUMS},
      count(*) FILTER (WHERE is_primary) AS turns
    FROM workbench_turn_usage WHERE ${usageScope(s)}
    GROUP BY 1`;
}

export function turnDurationSql(s: InsightsScope): SQL {
  return sql`
    SELECT ${PERCENTILES(sql`duration_ms`)}
    FROM workbench_turn_usage WHERE ${usageScope(s)} AND is_primary AND duration_ms IS NOT NULL`;
}

export async function loadAgents(s: InsightsScope): Promise<InsightsAgentsResponse> {
  const [modelRows, dayRows, [duration]] = await Promise.all([
    run<TokenRow & { agent: string; model: string; turns: unknown; failed_turns: unknown; turns_with_cost: unknown; cost_micros: unknown; agent_steps: unknown }>(agentsByModelSql(s)),
    run<TokenRow & { date: string; turns: unknown }>(agentsDaysSql(s)),
    run<PercentileRow>(turnDurationSql(s)),
  ]);
  const byModel: InsightsModelUsage[] = modelRows
    .map((r) => ({ agent: r.agent, model: r.model, turns: num(r.turns), costMicros: numOrNull(r.cost_micros), ...tokens(r) }))
    .sort((a, b) => b.outputTokens + b.inputTokens - (a.outputTokens + a.inputTokens));
  const addCost = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  const agents = new Map<string, InsightsAgentsResponse['byAgent'][number]>();
  for (const m of byModel) {
    const prev = agents.get(m.agent) ?? { agent: m.agent, turns: 0, costMicros: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    agents.set(m.agent, {
      agent: m.agent,
      turns: prev.turns + m.turns,
      costMicros: addCost(prev.costMicros, m.costMicros),
      inputTokens: prev.inputTokens + m.inputTokens,
      outputTokens: prev.outputTokens + m.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + m.cacheReadTokens,
      cacheWriteTokens: prev.cacheWriteTokens + m.cacheWriteTokens,
    });
  }
  const byDay = new Map(dayRows.map((r) => [r.date, { turns: num(r.turns), ...tokens(r) }]));
  const days: InsightsAgentDay[] = utcDays(s.from, s.to).map((date) => ({
    date,
    ...(byDay.get(date) ?? { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  }));
  const sum = (pick: (r: (typeof modelRows)[number]) => unknown) => modelRows.reduce((acc, r) => acc + num(pick(r)), 0);
  return {
    range: publicRange(s),
    totals: {
      inputTokens: sum((r) => r.input_tokens),
      outputTokens: sum((r) => r.output_tokens),
      cacheReadTokens: sum((r) => r.cache_read_tokens),
      cacheWriteTokens: sum((r) => r.cache_write_tokens),
      turns: sum((r) => r.turns),
      failedTurns: sum((r) => r.failed_turns),
      agentSteps: sum((r) => r.agent_steps),
      costMicros: byModel.reduce<number | null>((acc, m) => addCost(acc, m.costMicros), null),
      turnsWithCost: sum((r) => r.turns_with_cost),
    },
    byAgent: [...agents.values()].sort((a, b) => b.turns - a.turns),
    byModel,
    days,
    turnDuration: percentiles(duration),
  };
}

// ---------- Output ----------

const inRange = (column: SQL, s: InsightsScope) => sql`${column} >= ${ts(s.from)} AND ${column} < ${ts(s.to)}`;

export function outputCountsSql(s: InsightsScope): SQL {
  const ws = s.workspaceId;
  return sql`
    SELECT
      (SELECT count(*) FROM workbenches
        WHERE workspace_id = ${ws} AND kind = 'session' AND ${inRange(sql`created_at`, s)}) AS sessions_created,
      (SELECT count(*) FROM workbenches
        WHERE workspace_id = ${ws} AND ${inRange(sql`pull_request_linked_at`, s)}) AS sessions_with_pr,
      (SELECT count(*) FROM workbenches w JOIN pull_requests p ON p.id = w.pull_request_id
        WHERE w.workspace_id = ${ws} AND p.state = 'merged' AND ${inRange(sql`p.merged_at`, s)}) AS session_prs_merged,
      (SELECT count(*) FROM tasks WHERE workspace_id = ${ws} AND ${inRange(sql`created_at`, s)}) AS tasks_created,
      (SELECT count(*) FROM tasks WHERE workspace_id = ${ws} AND status = 'completed' AND ${inRange(sql`created_at`, s)}) AS tasks_completed,
      (SELECT count(*) FROM tasks WHERE workspace_id = ${ws} AND status = 'failed' AND ${inRange(sql`created_at`, s)}) AS tasks_failed,
      (SELECT count(*) FROM tasks WHERE workspace_id = ${ws} AND type = 'code_writing'
        AND pull_request_id IS NOT NULL AND ${inRange(sql`created_at`, s)}) AS tasks_with_pr,
      (SELECT count(*) FROM merge_queue_events e JOIN merge_queue_entries q ON q.id = e.entry_id
        WHERE q.workspace_id = ${ws} AND e.to_status = 'merged' AND ${inRange(sql`e.at`, s)}) AS queue_landed,
      (SELECT count(DISTINCT review_id || ':' || cycle) FROM pr_code_review_runs
        WHERE workspace_id = ${ws} AND ${inRange(sql`created_at`, s)}) AS reviews`;
}

/** Fix runs by what started them. `metadata ->> 'source'` ships one short string, never the blob. */
export function fixRunsSql(s: InsightsScope): SQL {
  return sql`
    SELECT COALESCE(metadata ->> 'source', 'other') AS source, count(*) AS n
    FROM tasks WHERE workspace_id = ${s.workspaceId} AND type = 'pr_response' AND ${inRange(sql`created_at`, s)}
    GROUP BY 1`;
}

export function findingsSql(s: InsightsScope): SQL {
  return sql`
    SELECT severity, count(*) AS n
    FROM pr_code_review_findings
    WHERE workspace_id = ${s.workspaceId} AND verdict <> 'rejected' AND ${inRange(sql`created_at`, s)}
    GROUP BY severity`;
}

const SEVERITY_ORDER = ['blocker', 'major', 'minor', 'nit'];

export async function loadOutput(s: InsightsScope): Promise<InsightsOutputResponse> {
  const [[c], fixRows, findingRows] = await Promise.all([
    run<Record<string, unknown>>(outputCountsSql(s)),
    run<{ source: string; n: unknown }>(fixRunsSql(s)),
    run<{ severity: string; n: unknown }>(findingsSql(s)),
  ]);
  const rank = (severity: string) => {
    const i = SEVERITY_ORDER.indexOf(severity);
    return i === -1 ? SEVERITY_ORDER.length : i;
  };
  return {
    range: publicRange(s),
    sessions: {
      created: num(c?.sessions_created),
      withPullRequest: num(c?.sessions_with_pr),
      pullRequestsMerged: num(c?.session_prs_merged),
    },
    tasks: {
      created: num(c?.tasks_created),
      completed: num(c?.tasks_completed),
      failed: num(c?.tasks_failed),
      withPullRequest: num(c?.tasks_with_pr),
    },
    fixRuns: fixRows.map((r) => ({ source: r.source, count: num(r.n) })).sort((a, b) => b.count - a.count),
    mergeQueue: { landed: num(c?.queue_landed) },
    codeReview: {
      reviews: num(c?.reviews),
      findings: findingRows.map((r) => ({ severity: r.severity, count: num(r.n) })).sort((a, b) => rank(a.severity) - rank(b.severity)),
    },
  };
}

// ---------- Speed ----------

export function bootSamplesSql(s: InsightsScope): SQL {
  return sql`
    SELECT kind, bucket, GROUPING(bucket) AS whole, ${PERCENTILES(sql`ms`)}
    FROM (
      SELECT kind, ms, COALESCE(CASE WHEN kind = 'box_start' THEN cause ELSE source END, 'unknown') AS bucket
      FROM workbench_boot_samples
      WHERE workspace_id = ${s.workspaceId} AND ${inRange(sql`at`, s)}
    ) samples
    GROUP BY GROUPING SETS ((kind), (kind, bucket))`;
}

export function firstReplySql(s: InsightsScope): SQL {
  return sql`
    SELECT ${PERCENTILES(sql`first_reply_ms`)}
    FROM workbench_turn_usage WHERE ${usageScope(s)} AND is_primary AND first_reply_ms IS NOT NULL`;
}

/** The first turn of each session created in the window. */
export function firstReplyNewSessionSql(s: InsightsScope): SQL {
  return sql`
    SELECT ${PERCENTILES(sql`f.first_reply_ms`)}
    FROM workbenches w
    CROSS JOIN LATERAL (
      SELECT u.first_reply_ms FROM workbench_turn_usage u
      WHERE u.workbench_id = w.id AND u.is_primary
      ORDER BY u.ended_at LIMIT 1
    ) f
    WHERE w.workspace_id = ${s.workspaceId} AND ${inRange(sql`w.created_at`, s)} AND f.first_reply_ms IS NOT NULL`;
}

export function turnStartSql(s: InsightsScope): SQL {
  return sql`
    SELECT ${PERCENTILES(sql`t.start_ms`)}
    FROM workbench_turn_timings t JOIN workbenches w ON w.id = t.workbench_id
    WHERE w.workspace_id = ${s.workspaceId} AND t.start_ms IS NOT NULL AND ${inRange(sql`t.created_at`, s)}`;
}

export async function loadSpeed(s: InsightsScope): Promise<InsightsSpeedResponse> {
  const [bootRows, [reply], [replyNew], [turnStart]] = await Promise.all([
    run<PercentileRow & { kind: string; bucket: string | null; whole: unknown }>(bootSamplesSql(s)),
    run<PercentileRow>(firstReplySql(s)),
    run<PercentileRow>(firstReplyNewSessionSql(s)),
    run<PercentileRow>(turnStartSql(s)),
  ]);
  const whole = (kind: string) => bootRows.find((r) => r.kind === kind && num(r.whole) === 1);
  const parts = (kind: string) => bootRows
    .filter((r) => r.kind === kind && num(r.whole) === 0 && r.bucket !== null)
    .map((r) => ({ bucket: r.bucket as string, ...percentiles(r) }))
    .sort((a, b) => b.count - a.count);
  return {
    range: publicRange(s),
    boxStart: { ...percentiles(whole('box_start')), byCause: parts('box_start').map(({ bucket, ...p }) => ({ cause: bucket, ...p })) },
    wake: { ...percentiles(whole('wake')), bySource: parts('wake').map(({ bucket, ...p }) => ({ source: bucket, ...p })) },
    firstReply: percentiles(reply),
    firstReplyNewSession: percentiles(replyNew),
    turnStart: percentiles(turnStart),
  };
}

// ---------- Top lists ----------

/** The repository a usage interval ran for: the session's, the task's, or the reviewed PR's. */
const INTERVAL_REPOSITORY = sql`COALESCE(NULLIF(w.repo_full_name, ''), rt.name, rr.name)`;

export function repositoryHoursSql(s: InsightsScope): SQL {
  return sql`
    SELECT repository, wsec FROM (
      SELECT ${INTERVAL_REPOSITORY} AS repository, COALESCE(sum(ui.billed_wsec), 0) AS wsec
      FROM usage_intervals ui
      LEFT JOIN workbenches w ON ui.subject_kind = 'workbench' AND w.id = ui.subject_id
      LEFT JOIN tasks t ON ui.subject_kind = 'task' AND t.id = ui.subject_id
      LEFT JOIN repositories rt ON rt.id = t.repository_id
      LEFT JOIN pr_code_review_runs run ON ui.subject_kind = 'review_unit' AND run.id = ui.subject_id
      LEFT JOIN pr_code_reviews rv ON rv.id = run.review_id
      LEFT JOIN repositories rr ON rr.id = rv.repository_id
      WHERE ui.owner_id = ${s.ownerId} AND ui.workspace_id = ${s.workspaceId}
        AND ${inRange(sql`ui.started_at`, s)}
      GROUP BY 1
    ) r WHERE repository IS NOT NULL`;
}

export function repositoryTokensSql(s: InsightsScope): SQL {
  return sql`
    SELECT repository, tokens FROM (
      SELECT NULLIF(w.repo_full_name, '') AS repository, COALESCE(sum(${TOKEN_TOTAL}), 0) AS tokens
      FROM workbench_turn_usage u JOIN workbenches w ON w.id = u.workbench_id
      WHERE u.workspace_id = ${s.workspaceId} AND ${inRange(sql`u.ended_at`, s)}
      GROUP BY 1
    ) r WHERE repository IS NOT NULL`;
}

const idList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/** Session box time, the top N, or for the given sessions. */
export function sessionHoursSql(s: InsightsScope, ids?: readonly string[]): SQL {
  return sql`
    SELECT subject_id AS id, COALESCE(sum(billed_wsec), 0) AS wsec
    FROM usage_intervals
    WHERE ${intervalScope(s)} AND subject_kind = 'workbench'
      ${ids ? sql`AND subject_id IN (${idList(ids)})` : sql``}
    GROUP BY subject_id
    ${ids ? sql`` : sql`ORDER BY wsec DESC LIMIT ${INSIGHTS_TOP_LIMIT}`}`;
}

export function sessionTokensSql(s: InsightsScope, ids?: readonly string[]): SQL {
  return sql`
    SELECT workbench_id AS id, COALESCE(sum(${TOKEN_TOTAL}), 0) AS tokens
    FROM workbench_turn_usage
    WHERE ${usageScope(s)} ${ids ? sql`AND workbench_id IN (${idList(ids)})` : sql``}
    GROUP BY workbench_id
    ${ids ? sql`` : sql`ORDER BY tokens DESC LIMIT ${INSIGHTS_TOP_LIMIT}`}`;
}

/** Names of the listed sessions. Scalar columns only; never `settings`. */
export function sessionNamesSql(workspaceId: string, ids: readonly string[]): SQL {
  return sql`
    SELECT id, COALESCE(title, name) AS title, NULLIF(repo_full_name, '') AS repository, archived_at IS NOT NULL AS archived
    FROM workbenches WHERE workspace_id = ${workspaceId} AND id IN (${idList(ids)})`;
}

export async function loadTop(s: InsightsScope): Promise<InsightsTopResponse> {
  const [repoHours, repoTokens, topHours, topTokens] = await Promise.all([
    run<{ repository: string; wsec: unknown }>(repositoryHoursSql(s)),
    run<{ repository: string; tokens: unknown }>(repositoryTokensSql(s)),
    run<{ id: string; wsec: unknown }>(sessionHoursSql(s)),
    run<{ id: string; tokens: unknown }>(sessionTokensSql(s)),
  ]);

  const repos = new Map<string, InsightsTopRepository>();
  const repo = (name: string) => repos.get(name) ?? repos.set(name, { repository: name, wsec: 0, tokens: 0 }).get(name)!;
  for (const r of repoHours) repo(r.repository).wsec = num(r.wsec);
  for (const r of repoTokens) repo(r.repository).tokens = num(r.tokens);
  const repoList = [...repos.values()];
  const top = <T>(list: T[], key: (t: T) => number) =>
    list.filter((t) => key(t) > 0).sort((a, b) => key(b) - key(a)).slice(0, INSIGHTS_TOP_LIMIT);

  const ids = [...new Set([...topHours.map((r) => r.id), ...topTokens.map((r) => r.id)])];
  let sessions: InsightsTopSession[] = [];
  if (ids.length > 0) {
    const [hours, toks, names] = await Promise.all([
      run<{ id: string; wsec: unknown }>(sessionHoursSql(s, ids)),
      run<{ id: string; tokens: unknown }>(sessionTokensSql(s, ids)),
      run<{ id: string; title: string | null; repository: string | null; archived: unknown }>(sessionNamesSql(s.workspaceId, ids)),
    ]);
    const wsec = new Map(hours.map((r) => [r.id, num(r.wsec)]));
    const tok = new Map(toks.map((r) => [r.id, num(r.tokens)]));
    const name = new Map(names.map((r) => [r.id, r]));
    sessions = ids.map((id) => {
      const n = name.get(id);
      return {
        workbenchId: id,
        title: n?.title ?? null,
        repository: n?.repository ?? null,
        archived: n ? n.archived === true || n.archived === 't' : false,
        wsec: wsec.get(id) ?? 0,
        tokens: tok.get(id) ?? 0,
      };
    });
  }
  return {
    range: publicRange(s),
    repositoriesByHours: top(repoList, (r) => r.wsec),
    repositoriesByTokens: top(repoList, (r) => r.tokens),
    sessionsByHours: top(sessions, (r) => r.wsec),
    sessionsByTokens: top(sessions, (r) => r.tokens),
  };
}
