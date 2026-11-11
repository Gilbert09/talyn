import { and, asc, desc, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import {
  BACKGROUND_COMMAND_PREVIEW_CHARS,
  type WorkbenchBackgroundJob,
  type WorkbenchBackgroundJobStatus,
  type WorkbenchWakeup,
  type WorkbenchWakeupCreatedBy,
  type WorkbenchWakeupStatus,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import {
  pullRequests,
  workbenchBackgroundJobs as jobs,
  workbenchChats,
  workbenches,
  workbenchWakeups as wakeups,
} from '../../db/schema.js';

/**
 * Storage for session background jobs and wake-ups (migration 0119). Both
 * tables are backend-pool-only, so every read and write is on the pool.
 */
const db = (): Database => getPoolDbClient();

/**
 * How many ended jobs and settled wake-ups a list shows after every live one.
 * A display window for the Background panel; it limits no work.
 */
export const BACKGROUND_RECENT_ROWS = 20;

/** Every job column. The sweep and the actions need the box facts and the payer. */
export const JOB_COLUMNS = {
  id: jobs.id,
  workbenchId: jobs.workbenchId,
  chatId: jobs.chatId,
  workspaceId: jobs.workspaceId,
  sandboxId: jobs.sandboxId,
  name: jobs.name,
  command: jobs.command,
  cwd: jobs.cwd,
  status: jobs.status,
  exitCode: jobs.exitCode,
  detail: jobs.detail,
  durableKey: jobs.durableKey,
  marker: jobs.marker,
  keepAwakeUntil: jobs.keepAwakeUntil,
  notifyOnExit: jobs.notifyOnExit,
  payerUserId: jobs.payerUserId,
  payerWorkspaceId: jobs.payerWorkspaceId,
  startedAt: jobs.startedAt,
  endedAt: jobs.endedAt,
  lastCheckedAt: jobs.lastCheckedAt,
} as const;
export type JobRow = Pick<typeof jobs.$inferSelect, keyof typeof JOB_COLUMNS>;

/** What a list shows: no box facts, no payer, and the command cut to a preview. */
export const JOB_LIST_COLUMNS = {
  id: jobs.id,
  workbenchId: jobs.workbenchId,
  chatId: jobs.chatId,
  name: jobs.name,
  command: sql<string>`left(${jobs.command}, ${sql.raw(String(BACKGROUND_COMMAND_PREVIEW_CHARS))})`,
  cwd: jobs.cwd,
  status: jobs.status,
  exitCode: jobs.exitCode,
  detail: jobs.detail,
  keepAwakeUntil: jobs.keepAwakeUntil,
  notifyOnExit: jobs.notifyOnExit,
  startedAt: jobs.startedAt,
  endedAt: jobs.endedAt,
  lastCheckedAt: jobs.lastCheckedAt,
} as const;
type JobListRow = Omit<Pick<typeof jobs.$inferSelect, keyof typeof JOB_LIST_COLUMNS>, 'command'> & { command: string };

/** Every wake-up column, `prompt` (a job's log tail) included. Only firing reads it. */
export const WAKEUP_COLUMNS = {
  id: wakeups.id,
  workbenchId: wakeups.workbenchId,
  chatId: wakeups.chatId,
  workspaceId: wakeups.workspaceId,
  wakeAt: wakeups.wakeAt,
  reason: wakeups.reason,
  prompt: wakeups.prompt,
  status: wakeups.status,
  failureDetail: wakeups.failureDetail,
  createdBy: wakeups.createdBy,
  payerUserId: wakeups.payerUserId,
  payerWorkspaceId: wakeups.payerWorkspaceId,
  sourceJobId: wakeups.sourceJobId,
  ciPullRequestId: wakeups.ciPullRequestId,
  ciHeadSha: wakeups.ciHeadSha,
  ciPrHeadAtSchedule: wakeups.ciPrHeadAtSchedule,
  createdAt: wakeups.createdAt,
  firedAt: wakeups.firedAt,
} as const;
export type WakeupRow = Pick<typeof wakeups.$inferSelect, keyof typeof WAKEUP_COLUMNS>;

/** What a list shows: never `prompt`, never the payer. */
export const WAKEUP_LIST_COLUMNS = {
  id: wakeups.id,
  workbenchId: wakeups.workbenchId,
  chatId: wakeups.chatId,
  wakeAt: wakeups.wakeAt,
  reason: wakeups.reason,
  status: wakeups.status,
  failureDetail: wakeups.failureDetail,
  createdBy: wakeups.createdBy,
  sourceJobId: wakeups.sourceJobId,
  ciPullRequestId: wakeups.ciPullRequestId,
  ciHeadSha: wakeups.ciHeadSha,
  createdAt: wakeups.createdAt,
  firedAt: wakeups.firedAt,
} as const;
type WakeupListRow = Pick<typeof wakeups.$inferSelect, keyof typeof WAKEUP_LIST_COLUMNS>;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function publicJob(row: JobListRow): WorkbenchBackgroundJob {
  const command = row.command.length > BACKGROUND_COMMAND_PREVIEW_CHARS
    ? row.command.slice(0, BACKGROUND_COMMAND_PREVIEW_CHARS)
    : row.command;
  return {
    id: row.id,
    workbenchId: row.workbenchId,
    chatId: row.chatId,
    name: row.name,
    command,
    cwd: row.cwd,
    status: row.status as WorkbenchBackgroundJobStatus,
    exitCode: row.exitCode,
    detail: row.detail,
    startedAt: row.startedAt.toISOString(),
    endedAt: iso(row.endedAt),
    keepAwakeUntil: iso(row.keepAwakeUntil),
    notifyOnExit: row.notifyOnExit,
    lastCheckedAt: iso(row.lastCheckedAt),
  };
}

export function publicWakeup(row: WakeupListRow): WorkbenchWakeup {
  return {
    id: row.id,
    workbenchId: row.workbenchId,
    chatId: row.chatId,
    wakeAt: row.wakeAt.toISOString(),
    reason: row.reason,
    status: row.status as WorkbenchWakeupStatus,
    failureDetail: row.failureDetail,
    createdBy: row.createdBy as WorkbenchWakeupCreatedBy,
    sourceJobId: row.sourceJobId,
    ci: row.ciPullRequestId && row.ciHeadSha ? { pullRequestId: row.ciPullRequestId, headSha: row.ciHeadSha } : null,
    createdAt: row.createdAt.toISOString(),
    firedAt: iso(row.firedAt),
  };
}

// ---------- Jobs ----------

export async function insertJob(values: typeof jobs.$inferInsert): Promise<JobRow> {
  const [row] = await db().insert(jobs).values(values).returning(JOB_COLUMNS);
  return row;
}

export async function getJob(id: string): Promise<JobRow | null> {
  const [row] = await db().select(JOB_COLUMNS).from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ?? null;
}

export function runningJobsQuery(workbenchId: string) {
  return db().select(JOB_LIST_COLUMNS).from(jobs)
    .where(and(eq(jobs.workbenchId, workbenchId), eq(jobs.status, 'running')))
    .orderBy(desc(jobs.startedAt));
}

export function recentJobsQuery(workbenchId: string) {
  return db().select(JOB_LIST_COLUMNS).from(jobs)
    .where(and(eq(jobs.workbenchId, workbenchId), ne(jobs.status, 'running')))
    .orderBy(desc(jobs.endedAt), desc(jobs.startedAt))
    .limit(BACKGROUND_RECENT_ROWS);
}

export async function listJobs(workbenchId: string): Promise<WorkbenchBackgroundJob[]> {
  const [running, recent] = await Promise.all([runningJobsQuery(workbenchId), recentJobsQuery(workbenchId)]);
  return [...running, ...recent].map(publicJob);
}

/** The running jobs the sweep checks next: the ones checked longest ago first. */
export function sweepJobsQuery(limit: number) {
  return db().select(JOB_COLUMNS).from(jobs)
    .where(eq(jobs.status, 'running'))
    .orderBy(sql`${jobs.lastCheckedAt} ASC NULLS FIRST`)
    .limit(limit);
}

/** End a running job, once. Null when another caller ended it first. */
export async function settleJob(
  id: string,
  patch: { status: Exclude<WorkbenchBackgroundJobStatus, 'running'>; exitCode?: number | null; detail?: string | null },
  at = new Date(),
): Promise<JobRow | null> {
  const [row] = await db().update(jobs)
    .set({ status: patch.status, exitCode: patch.exitCode ?? null, detail: patch.detail ?? null, endedAt: at, lastCheckedAt: at })
    .where(and(eq(jobs.id, id), eq(jobs.status, 'running')))
    .returning(JOB_COLUMNS);
  return row ?? null;
}

export async function noteJobChecked(id: string, at = new Date()): Promise<void> {
  await db().update(jobs).set({ lastCheckedAt: at }).where(and(eq(jobs.id, id), eq(jobs.status, 'running')));
}

export async function setJobKeepAwake(id: string, until: Date | null, detail?: string): Promise<JobRow | null> {
  const [row] = await db().update(jobs)
    .set({ keepAwakeUntil: until, ...(detail !== undefined ? { detail } : {}) })
    .where(and(eq(jobs.id, id), eq(jobs.status, 'running')))
    .returning(JOB_COLUMNS);
  return row ?? null;
}

/**
 * Mark a session's running jobs lost when they started on a box other than
 * `currentSandboxId` (null: every running job). Returns how many.
 */
export async function markJobsLost(workbenchId: string, currentSandboxId: string | null, detail: string): Promise<number> {
  const now = new Date();
  const rows = await db().update(jobs)
    .set({ status: 'lost', detail, endedAt: now, lastCheckedAt: now })
    .where(and(
      eq(jobs.workbenchId, workbenchId),
      eq(jobs.status, 'running'),
      ...(currentSandboxId ? [ne(jobs.sandboxId, currentSandboxId)] : []),
    ))
    .returning({ id: jobs.id });
  return rows.length;
}

// ---------- Wake-ups ----------

/** Insert a wake-up. Null when the job already has its exit wake-up. */
export async function insertWakeup(values: typeof wakeups.$inferInsert): Promise<WakeupRow | null> {
  const [row] = await db().insert(wakeups).values(values).onConflictDoNothing().returning(WAKEUP_COLUMNS);
  return row ?? null;
}

export async function getWakeup(id: string): Promise<WakeupRow | null> {
  const [row] = await db().select(WAKEUP_COLUMNS).from(wakeups).where(eq(wakeups.id, id)).limit(1);
  return row ?? null;
}

export function scheduledWakeupsQuery(workbenchId: string) {
  return db().select(WAKEUP_LIST_COLUMNS).from(wakeups)
    .where(and(eq(wakeups.workbenchId, workbenchId), eq(wakeups.status, 'scheduled')))
    .orderBy(asc(wakeups.wakeAt));
}

export function recentWakeupsQuery(workbenchId: string) {
  return db().select(WAKEUP_LIST_COLUMNS).from(wakeups)
    .where(and(eq(wakeups.workbenchId, workbenchId), ne(wakeups.status, 'scheduled')))
    .orderBy(desc(wakeups.createdAt))
    .limit(BACKGROUND_RECENT_ROWS);
}

export async function listWakeups(workbenchId: string): Promise<WorkbenchWakeup[]> {
  const [scheduled, recent] = await Promise.all([scheduledWakeupsQuery(workbenchId), recentWakeupsQuery(workbenchId)]);
  return [...scheduled, ...recent].map(publicWakeup);
}

/** Due wake-ups, soonest first. Ids only: firing claims and reads each row. */
export function dueWakeupsQuery(now: Date, limit: number) {
  return db().select({ id: wakeups.id, workspaceId: wakeups.workspaceId }).from(wakeups)
    .where(and(eq(wakeups.status, 'scheduled'), lte(wakeups.wakeAt, now)))
    .orderBy(asc(wakeups.wakeAt))
    .limit(limit);
}

/** A scheduled CI wake-up with the facts of its pull request. */
export interface CiWakeupRow {
  id: string;
  workspaceId: string;
  /** The wake-up's chat. `running` means a turn is on, and the agent is awake to see CI for itself. */
  chatStatus: string | null;
  wakeAt: Date;
  ciPullRequestId: string;
  ciHeadSha: string;
  ciPrHeadAtSchedule: string | null;
  prState: string | null;
  prHeadSha: string | null;
  owner: string | null;
  repo: string | null;
  number: number | null;
}

/**
 * Scheduled CI wake-ups, with their pull request's state and head. All of
 * them, or only those on the given pull requests (the checks listener).
 */
export async function scheduledCiWakeups(opts: { pullRequestIds?: string[]; limit: number }): Promise<CiWakeupRow[]> {
  if (opts.pullRequestIds && opts.pullRequestIds.length === 0) return [];
  const rows = await db().select({
    id: wakeups.id,
    workspaceId: wakeups.workspaceId,
    chatStatus: workbenchChats.status,
    wakeAt: wakeups.wakeAt,
    ciPullRequestId: wakeups.ciPullRequestId,
    ciHeadSha: wakeups.ciHeadSha,
    ciPrHeadAtSchedule: wakeups.ciPrHeadAtSchedule,
    prState: pullRequests.state,
    prHeadSha: sql<string | null>`${pullRequests.lastSummary} ->> 'headSha'`,
    owner: pullRequests.owner,
    repo: pullRequests.repo,
    number: pullRequests.number,
  }).from(wakeups)
    .leftJoin(pullRequests, eq(pullRequests.id, wakeups.ciPullRequestId))
    .leftJoin(workbenchChats, eq(workbenchChats.id, wakeups.chatId))
    .where(and(
      eq(wakeups.status, 'scheduled'),
      isNotNull(wakeups.ciPullRequestId),
      ...(opts.pullRequestIds ? [inArray(wakeups.ciPullRequestId, opts.pullRequestIds)] : []),
    ))
    .orderBy(asc(wakeups.wakeAt))
    .limit(opts.limit);
  return rows.filter((r): r is CiWakeupRow => Boolean(r.ciPullRequestId && r.ciHeadSha));
}

/**
 * The claim: `scheduled` to `fired` in one statement. Two sweeps that both
 * read the row as due cannot both win it, so a wake-up sends one turn.
 */
export async function claimWakeup(id: string, at = new Date()): Promise<WakeupRow | null> {
  const [row] = await db().update(wakeups)
    .set({ status: 'fired', firedAt: at })
    .where(and(eq(wakeups.id, id), eq(wakeups.status, 'scheduled')))
    .returning(WAKEUP_COLUMNS);
  return row ?? null;
}

/** Record why a claimed or scheduled wake-up did not send its turn. */
export async function settleWakeup(
  id: string,
  from: WorkbenchWakeupStatus,
  to: 'cancelled' | 'failed',
  detail: string,
): Promise<WakeupRow | null> {
  const [row] = await db().update(wakeups)
    .set({ status: to, failureDetail: detail })
    .where(and(eq(wakeups.id, id), eq(wakeups.status, from)))
    .returning(WAKEUP_COLUMNS);
  return row ?? null;
}

/**
 * Cancel the scheduled CI wake-ups of one chat. A new CI wake-up replaces
 * them: after another push, the old one would only report a moved head.
 */
export async function cancelScheduledCiWakeups(workbenchId: string, chatId: string, detail: string): Promise<number> {
  const rows = await db().update(wakeups)
    .set({ status: 'cancelled', failureDetail: detail })
    .where(and(
      eq(wakeups.workbenchId, workbenchId),
      eq(wakeups.chatId, chatId),
      eq(wakeups.status, 'scheduled'),
      isNotNull(wakeups.ciPullRequestId),
    ))
    .returning({ id: wakeups.id });
  return rows.length;
}

/** Cancel every scheduled wake-up of an archived session. Returns the sessions touched. */
export async function cancelArchivedWakeups(): Promise<Array<{ workbenchId: string; workspaceId: string }>> {
  const archived = db().select({ id: workbenches.id }).from(workbenches).where(isNotNull(workbenches.archivedAt));
  const rows = await db().update(wakeups)
    .set({ status: 'cancelled', failureDetail: 'The session is archived.' })
    .where(and(eq(wakeups.status, 'scheduled'), inArray(wakeups.workbenchId, archived)))
    .returning({ workbenchId: wakeups.workbenchId, workspaceId: wakeups.workspaceId });
  const seen = new Map(rows.map((r) => [r.workbenchId, r]));
  return [...seen.values()];
}
