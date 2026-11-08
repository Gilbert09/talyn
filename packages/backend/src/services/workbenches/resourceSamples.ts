import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { SandboxUsageHistory, SandboxUsagePoint } from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { workbenchResourceSamples as samples } from '../../db/schema.js';

/**
 * CPU and memory samples of session boxes (migration 0121), for the chart in
 * the Sandbox panel. The usage sweep writes them each minute, so the table is
 * backend-pool-only like the other sweep tables.
 */
const db = (): Database => getPoolDbClient();

/** The span the Sandbox panel charts. */
export const USAGE_WINDOW_MINUTES = 60;
/** The usage sweep's tick. */
export const SAMPLE_STEP_SECONDS = 60;
/** Rows older than this go. A margin over the window, so the first point has a sample before it. */
export const SAMPLE_RETENTION_MS = 2 * 60 * 60_000;
/** A gap longer than this between two samples is a break in the line, and no CPU figure spans it. */
const MAX_STEP_MS = 3 * SAMPLE_STEP_SECONDS * 1000;
/** A live read this close to the newest stored sample adds nothing. */
const MIN_LIVE_GAP_MS = 5_000;

export interface ResourceSample {
  workbenchId: string;
  sandboxId: string;
  sampledAt: Date;
  memUsedMib: number | null;
  memLimitMib: number | null;
  cpuSeconds: number | null;
  vcpus: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A sample from the fleet's record of a box. Null when the record carries no use figure. */
export function sampleFromFleet(
  workbenchId: string,
  box: { id: string; memUsedMib?: number; cpuSeconds?: number; memMib?: number; milliVcpu?: number; vcpuCount?: number },
  sampledAt: Date,
): ResourceSample | null {
  const memUsedMib = num(box.memUsedMib);
  const cpuSeconds = num(box.cpuSeconds);
  if (memUsedMib === null && cpuSeconds === null) return null;
  const vcpus = box.milliVcpu ? box.milliVcpu / 1000 : num(box.vcpuCount);
  return { workbenchId, sandboxId: box.id, sampledAt, memUsedMib, memLimitMib: num(box.memMib), cpuSeconds, vcpus };
}

export async function recordResourceSamples(rows: ResourceSample[]): Promise<void> {
  if (rows.length === 0) return;
  await db().insert(samples).values(rows).onConflictDoNothing();
}

export async function pruneResourceSamples(now: Date): Promise<void> {
  await db().delete(samples).where(lt(samples.sampledAt, new Date(now.getTime() - SAMPLE_RETENTION_MS)));
}

/** The samples the chart needs: the window, and the samples just before it for the first CPU figure. */
export async function readResourceSamples(workbenchId: string, now: Date): Promise<ResourceSample[]> {
  const since = new Date(now.getTime() - USAGE_WINDOW_MINUTES * 60_000 - MAX_STEP_MS);
  return db()
    .select()
    .from(samples)
    .where(and(eq(samples.workbenchId, workbenchId), gte(samples.sampledAt, since)))
    .orderBy(asc(samples.sampledAt));
}

/** CPU use between two samples of the same box, as a percent of its vCPUs. Null when it cannot be known. */
export function cpuPercentBetween(prev: ResourceSample | undefined, cur: ResourceSample): number | null {
  if (!prev || prev.sandboxId !== cur.sandboxId) return null;
  if (prev.cpuSeconds === null || cur.cpuSeconds === null || !cur.vcpus) return null;
  const ms = cur.sampledAt.getTime() - prev.sampledAt.getTime();
  // A lower counter is a new VMM: a restart or a resume on another host.
  if (ms <= 0 || ms > MAX_STEP_MS || cur.cpuSeconds < prev.cpuSeconds) return null;
  const percent = ((cur.cpuSeconds - prev.cpuSeconds) / (ms / 1000) / cur.vcpus) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
}

/**
 * The chart's points, oldest first. `live` is the fleet's record read for this
 * status, so the newest point is current and not up to a minute old. Pure.
 */
export function describeUsageHistory(stored: ResourceSample[], live: ResourceSample | null, now: Date): SandboxUsageHistory | null {
  const all = [...stored].sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
  const last = all[all.length - 1];
  if (live && (!last || live.sampledAt.getTime() - last.sampledAt.getTime() >= MIN_LIVE_GAP_MS)) all.push(live);
  const from = now.getTime() - USAGE_WINDOW_MINUTES * 60_000;
  const points: SandboxUsagePoint[] = [];
  let cpuReported = false;
  let memoryLimitMib: number | null = null;
  all.forEach((sample, i) => {
    if (sample.sampledAt.getTime() < from) return;
    if (sample.cpuSeconds !== null) cpuReported = true;
    if (sample.memLimitMib !== null) memoryLimitMib = sample.memLimitMib;
    points.push({
      at: sample.sampledAt.toISOString(),
      memoryUsedMib: sample.memUsedMib,
      cpuPercent: cpuPercentBetween(all[i - 1], sample),
    });
  });
  if (points.length === 0) return null;
  return { windowMinutes: USAGE_WINDOW_MINUTES, stepSeconds: SAMPLE_STEP_SECONDS, memoryLimitMib, cpuReported, points };
}
