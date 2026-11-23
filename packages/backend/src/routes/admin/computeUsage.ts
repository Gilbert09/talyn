import { Router } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import type { ApiResponse } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { AdminGuardError, withGuards } from './guards.js';

const SORT_COLUMNS = {
  period_hours: sql`period_used_hours`,
  all_time_hours: sql`all_time_hours`,
  sessions: sql`sessions_total`,
  running: sql`boxes_running`,
  last_active: sql`last_active_at`,
} as const;

type Sort = keyof typeof SORT_COLUMNS;

export interface ComputeUsageRow {
  user_id: string;
  email: string;
  tier: string | null;
  plan_override: string | null;
  period_start: string | null;
  period_end: string | null;
  period_used_hours: number;
  period_included_hours: number;
  credits_used_usd: number;
  all_time_hours: number;
  hours_last_7_days: number;
  sessions_total: number;
  sessions_active: number;
  boxes_running: number;
  last_active_at: string | null;
}

export interface ComputeUsageTotals {
  users: number;
  period_used_hours: number;
  all_time_hours: number;
  sessions_total: number;
  boxes_running: number;
}

function rows(result: unknown): Record<string, unknown>[] {
  return (Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows) ?? [];
}

function value(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new AdminGuardError(400, 'invalid_parameter', `Invalid ${name}.`);
  return raw;
}

function queryParams(query: Record<string, unknown>) {
  const sort = value(query.sort, 'sort') ?? 'period_hours';
  const order = value(query.order, 'order') ?? 'desc';
  const rawLimit = value(query.limit, 'limit');
  const q = value(query.q, 'q')?.trim() ?? '';
  if (!Object.hasOwn(SORT_COLUMNS, sort)) throw new AdminGuardError(400, 'invalid_sort', 'Invalid sort.');
  if (order !== 'asc' && order !== 'desc') throw new AdminGuardError(400, 'invalid_order', 'Invalid order.');
  if (rawLimit !== undefined && (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 500)) {
    throw new AdminGuardError(400, 'invalid_limit', 'Limit must be between 1 and 500.');
  }
  return { sort: sort as Sort, order, limit: rawLimit ? Number(rawLimit) : 100, q };
}

function usageBase(now: string, lastWeek: string, q: string): SQL {
  return sql`
    WITH interval_usage AS (
      SELECT owner_id,
        SUM(billed_wsec)::numeric / 3600 AS all_time_hours,
        SUM(CASE WHEN started_at >= ${lastWeek}::timestamptz THEN billed_wsec ELSE 0 END)::numeric / 3600 AS hours_last_7_days,
        COUNT(*) FILTER (WHERE ended_at IS NULL) AS boxes_running,
        MAX(started_at) AS last_interval_at
      FROM usage_intervals GROUP BY owner_id
    ), session_usage AS (
      SELECT w.owner_id,
        COUNT(*) AS sessions_total,
        COUNT(*) FILTER (WHERE b.archived_at IS NULL) AS sessions_active,
        MAX(b.created_at) AS last_session_at
      FROM workspaces w JOIN workbenches b ON b.workspace_id = w.id
      GROUP BY w.owner_id
    ), current_period AS (
      SELECT DISTINCT ON (owner_id) owner_id, tier, period_start, period_end,
        used_wsec + reset_used_wsec AS used_wsec, included_wsec, credit_micros_used
      FROM usage_periods
      WHERE period_start <= ${now}::timestamptz AND period_end > ${now}::timestamptz
      ORDER BY owner_id, period_start DESC
    ), filtered AS (
      SELECT u.id AS user_id, u.email, p.tier, u.plan_override,
        p.period_start, p.period_end,
        COALESCE(p.used_wsec, 0)::numeric / 3600 AS period_used_hours,
        COALESCE(p.included_wsec, 0)::numeric / 3600 AS period_included_hours,
        COALESCE(p.credit_micros_used, 0)::numeric / 1000000 AS credits_used_usd,
        COALESCE(i.all_time_hours, 0) AS all_time_hours,
        COALESCE(i.hours_last_7_days, 0) AS hours_last_7_days,
        COALESCE(s.sessions_total, 0) AS sessions_total,
        COALESCE(s.sessions_active, 0) AS sessions_active,
        COALESCE(i.boxes_running, 0) AS boxes_running,
        GREATEST(i.last_interval_at, s.last_session_at) AS last_active_at
      FROM users u
      LEFT JOIN interval_usage i ON i.owner_id = u.id
      LEFT JOIN session_usage s ON s.owner_id = u.id
      LEFT JOIN current_period p ON p.owner_id = u.id
      WHERE (i.owner_id IS NOT NULL OR s.owner_id IS NOT NULL)
        AND (${q} = '' OR POSITION(LOWER(${q}) IN LOWER(u.email)) > 0)
    )
  `;
}

export interface ComputeDailyPoint {
  /** UTC day of the bucket, `YYYY-MM-DD`. */
  day: string;
  /** Bucket start, ISO timestamp. */
  start: string;
  /** Box-hours: wall-clock hours times the size weight, as billing counts them. */
  hours: number;
  wall_hours: number;
  boxes_started: number;
}

export interface ComputeBreakdown {
  key: string;
  hours: number;
}

export interface ComputeUserHours {
  user_id: string;
  email: string | null;
  hours: number;
}

export type ComputeRange = number | 'today' | 'yesterday';
export type ComputeBucket = 'day' | 'hour';

export interface ComputeDailyStats {
  start: string;
  end: string;
  /** `hour` for the today and yesterday ranges, else `day`. */
  bucket: ComputeBucket;
  user_id: string | null;
  user_email: string | null;
  days: ComputeDailyPoint[];
  totals: {
    hours: number;
    wall_hours: number;
    boxes_started: number;
    peak_day: string | null;
    /** Start of the peak bucket, ISO timestamp. */
    peak_start: string | null;
    peak_hours: number;
  };
  by_kind: ComputeBreakdown[];
  by_size: ComputeBreakdown[];
  /** Every account with usage in the range, most hours first. Ignores the user filter. */
  users: ComputeUserHours[];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_DAYS = 180;
const MAX_USERS = 500;

function dailyParams(query: Record<string, unknown>) {
  const rawDays = value(query.days, 'days');
  if (rawDays !== undefined && (!/^[1-9]\d*$/.test(rawDays) || Number(rawDays) > MAX_DAYS)) {
    throw new AdminGuardError(400, 'invalid_days', `Days must be between 1 and ${MAX_DAYS}.`);
  }
  const range = value(query.range, 'range');
  if (range !== undefined && range !== 'today' && range !== 'yesterday') {
    throw new AdminGuardError(400, 'invalid_range', 'Range must be today or yesterday.');
  }
  const userId = value(query.userId, 'userId')?.trim() || null;
  const parsed: ComputeRange = range === 'today' || range === 'yesterday' ? range : rawDays ? Number(rawDays) : 30;
  return { range: parsed, userId };
}

/** Bucket bounds in ms. The last bucket is the one that holds `end`, or for yesterday the 23:00 hour. */
function rangeWindow(now: Date, range: ComputeRange) {
  const nowMs = now.getTime();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (range === 'yesterday') {
    return { start: todayStart - DAY_MS, end: todayStart, lastBucket: todayStart - HOUR_MS, bucket: 'hour' as const };
  }
  const [start, size] = range === 'today' ? [todayStart, HOUR_MS] : [todayStart - (range - 1) * DAY_MS, DAY_MS];
  const lastBucket = start + Math.floor((nowMs - start) / size) * size;
  return { start, end: nowMs, lastBucket, bucket: range === 'today' ? 'hour' as const : 'day' as const };
}

// Seconds of each interval that fall inside [lo, hi) and before `cap`, with an open interval running to `cap`.
function overlapSeconds(lo: SQL, hi: SQL, cap: string): SQL {
  return sql`GREATEST(EXTRACT(EPOCH FROM
    LEAST(COALESCE(i.ended_at, ${cap}::timestamptz), ${cap}::timestamptz, ${hi})
    - GREATEST(i.started_at, ${lo})), 0)`;
}

function sortBreakdown(totals: Map<string, number>): ComputeBreakdown[] {
  return [...totals].map(([key, hours]) => ({ key, hours })).sort((a, b) => b.hours - a.hours || a.key.localeCompare(b.key));
}

export async function computeDailyStats(now: Date, range: ComputeRange, userId: string | null): Promise<ComputeDailyStats> {
  const bounds = rangeWindow(now, range);
  const bucketMs = bounds.bucket === 'hour' ? HOUR_MS : DAY_MS;
  const start = new Date(bounds.start).toISOString();
  const lastBucket = new Date(bounds.lastBucket).toISOString();
  const endIso = new Date(bounds.end).toISOString();
  const db = getPoolDbClient();
  const inRange = sql`i.started_at < ${endIso}::timestamptz
    AND (i.ended_at IS NULL OR i.ended_at > ${start}::timestamptz)`;
  const owner = userId ? sql`AND i.owner_id = ${userId}` : sql``;
  // 24 hours, not 1 day: a timestamptz plus '1 day' follows the session time zone across DST.
  const step = bounds.bucket === 'hour' ? sql`interval '1 hour'` : sql`interval '24 hours'`;
  const dayEnd = sql`d.day_start + ${step}`;
  const overlap = overlapSeconds(sql`d.day_start`, dayEnd, endIso);

  const [dailyResult, usersResult, emailResult] = await Promise.all([
    db.execute(sql`
      WITH days AS (
        SELECT generate_series(${start}::timestamptz, ${lastBucket}::timestamptz, ${step}) AS day_start
      )
      SELECT d.day_start, i.subject_kind, i.size,
        SUM(${overlap}) AS wall_sec,
        SUM(${overlap} * i.weight::numeric) AS weighted_sec,
        COUNT(*) FILTER (WHERE i.started_at >= d.day_start) AS started
      FROM days d
      JOIN usage_intervals i ON i.started_at < ${dayEnd}
        AND (i.ended_at IS NULL OR i.ended_at > d.day_start)
      WHERE ${inRange} ${owner}
      GROUP BY d.day_start, i.subject_kind, i.size
    `),
    db.execute(sql`
      SELECT i.owner_id, u.email,
        SUM(${overlapSeconds(sql`${start}::timestamptz`, sql`${endIso}::timestamptz`, endIso)} * i.weight::numeric) AS weighted_sec
      FROM usage_intervals i LEFT JOIN users u ON u.id = i.owner_id
      WHERE ${inRange}
      GROUP BY i.owner_id, u.email
      ORDER BY weighted_sec DESC, i.owner_id ASC
      LIMIT ${MAX_USERS}
    `),
    userId ? db.execute(sql`SELECT email FROM users WHERE id = ${userId}`) : Promise.resolve(null),
  ]);

  const points = new Map<string, ComputeDailyPoint>();
  for (let t = bounds.start; t <= bounds.lastBucket; t += bucketMs) {
    const bucketStart = new Date(t).toISOString();
    points.set(bucketStart, { day: bucketStart.slice(0, 10), start: bucketStart, hours: 0, wall_hours: 0, boxes_started: 0 });
  }
  const byKind = new Map<string, number>();
  const bySize = new Map<string, number>();
  for (const row of rows(dailyResult)) {
    const point = points.get(new Date(row.day_start as string).toISOString());
    if (!point) continue;
    const hours = Number(row.weighted_sec) / 3600;
    point.hours += hours;
    point.wall_hours += Number(row.wall_sec) / 3600;
    point.boxes_started += Number(row.started);
    byKind.set(String(row.subject_kind), (byKind.get(String(row.subject_kind)) ?? 0) + hours);
    bySize.set(String(row.size), (bySize.get(String(row.size)) ?? 0) + hours);
  }

  const series = [...points.values()];
  const peak = series.reduce<ComputeDailyPoint | null>((best, point) => (point.hours > (best?.hours ?? 0) ? point : best), null);
  const emailRow = emailResult ? rows(emailResult)[0] : undefined;
  return {
    start,
    end: endIso,
    bucket: bounds.bucket,
    user_id: userId,
    user_email: emailRow?.email == null ? null : String(emailRow.email),
    days: series,
    totals: {
      hours: series.reduce((sum, point) => sum + point.hours, 0),
      wall_hours: series.reduce((sum, point) => sum + point.wall_hours, 0),
      boxes_started: series.reduce((sum, point) => sum + point.boxes_started, 0),
      peak_day: peak?.day ?? null,
      peak_start: peak?.start ?? null,
      peak_hours: peak?.hours ?? 0,
    },
    by_kind: sortBreakdown(byKind),
    by_size: sortBreakdown(bySize),
    users: rows(usersResult).map((row) => ({
      user_id: String(row.owner_id),
      email: row.email == null ? null : String(row.email),
      hours: Number(row.weighted_sec) / 3600,
    })),
  };
}

export function adminComputeUsageRoutes(): Router {
  const router = Router();
  router.get('/compute/daily', withGuards(async (req, res) => {
    const { range, userId } = dailyParams(req.query);
    const data = await computeDailyStats(new Date(), range, userId);
    res.json({ success: true, data } as ApiResponse<ComputeDailyStats>);
  }));
  router.get('/compute', withGuards(async (req, res) => {
    const { sort, order, limit, q } = queryParams(req.query);
    const now = new Date();
    const base = usageBase(now.toISOString(), new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), q);
    const direction = order === 'asc' ? sql`ASC` : sql`DESC`;
    const result = await getPoolDbClient().execute(sql`${base}
      SELECT item.user_id, item.email, item.tier, item.plan_override,
        item.period_start, item.period_end, item.period_used_hours,
        item.period_included_hours, item.credits_used_usd, item.all_time_hours,
        item.hours_last_7_days, item.sessions_total, item.sessions_active,
        item.boxes_running, item.last_active_at,
        totals.users AS total_users,
        totals.period_used_hours AS total_period_used_hours,
        totals.all_time_hours AS total_all_time_hours,
        totals.sessions_total AS total_sessions_total,
        totals.boxes_running AS total_boxes_running
      FROM (
        SELECT COUNT(*) AS users,
          COALESCE(SUM(period_used_hours), 0) AS period_used_hours,
          COALESCE(SUM(all_time_hours), 0) AS all_time_hours,
          COALESCE(SUM(sessions_total), 0) AS sessions_total,
          COALESCE(SUM(boxes_running), 0) AS boxes_running
        FROM filtered
      ) totals
      LEFT JOIN (
        SELECT user_id, email, tier, plan_override, period_start, period_end,
          period_used_hours, period_included_hours, credits_used_usd,
          all_time_hours, hours_last_7_days, sessions_total, sessions_active,
          boxes_running, last_active_at
        FROM filtered ORDER BY ${SORT_COLUMNS[sort]} ${direction} NULLS LAST, user_id ASC LIMIT ${limit}
      ) item ON true
      ORDER BY ${SORT_COLUMNS[sort]} ${direction} NULLS LAST, item.user_id ASC
    `);
    const resultRows = rows(result);
    const items = resultRows.filter((row) => row.user_id != null).map((row): ComputeUsageRow => ({
      user_id: String(row.user_id),
      email: String(row.email),
      tier: row.tier == null ? null : String(row.tier),
      plan_override: row.plan_override == null ? null : String(row.plan_override),
      period_start: row.period_start == null ? null : new Date(row.period_start as string).toISOString(),
      period_end: row.period_end == null ? null : new Date(row.period_end as string).toISOString(),
      period_used_hours: Number(row.period_used_hours),
      period_included_hours: Number(row.period_included_hours),
      credits_used_usd: Number(row.credits_used_usd),
      all_time_hours: Number(row.all_time_hours),
      hours_last_7_days: Number(row.hours_last_7_days),
      sessions_total: Number(row.sessions_total),
      sessions_active: Number(row.sessions_active),
      boxes_running: Number(row.boxes_running),
      last_active_at: row.last_active_at == null ? null : new Date(row.last_active_at as string).toISOString(),
    }));
    const total = resultRows[0];
    const totals: ComputeUsageTotals = {
      users: Number(total.total_users),
      period_used_hours: Number(total.total_period_used_hours),
      all_time_hours: Number(total.total_all_time_hours),
      sessions_total: Number(total.total_sessions_total),
      boxes_running: Number(total.total_boxes_running),
    };
    res.json({ success: true, data: { items, totals } } as ApiResponse<{ items: ComputeUsageRow[]; totals: ComputeUsageTotals }>);
  }));
  return router;
}
