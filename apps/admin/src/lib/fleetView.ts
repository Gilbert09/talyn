import {
  SANDBOX_SIZES,
  type AdminFleetHost,
  type AdminIncidentSeverity,
  type AdminRunClaim,
  type AdminRunKind,
  type AdminRunRow,
} from '@talyn/shared';
import { mib, parseTime, pct } from './format';

/**
 * Pure derivations for the fleet views.
 *
 * Kept out of components deliberately so they can be tested without a DOM —
 * every one of these is a judgement an operator acts on ("is this host gone?",
 * "is this run wedged?"), and a judgement worth acting on is worth pinning.
 *
 * The staleness constant is duplicated from the backend on purpose. The
 * backend already computes `online` and sends it, and that value is what the
 * UI trusts; this constant exists only so a client-side countdown can say "3s
 * until stale" without a round trip. If they ever disagree, the server is
 * right — see `hostStatus`, which prefers the server's answer.
 */

/** Mirrors HOST_STALE_AFTER_MS in services/fleetHosts.ts: four missed reports. */
export const HOST_STALE_AFTER_MS = 60_000;

export type HostState = 'offline' | 'draining' | 'full' | 'ready';

/**
 * What a host row should say, in one word.
 *
 * Order matters and encodes precedence: an offline host is offline whatever
 * else its last report claimed, and a draining host is draining even if it
 * still has slots. Getting that backwards would show "ready" for a box that
 * cannot take work.
 */
export function hostState(host: AdminFleetHost): HostState {
  if (!host.online) return 'offline';
  if (host.draining) return 'draining';
  if (host.runsMax > 0 && host.runsLive >= host.runsMax) return 'full';
  return 'ready';
}

export function hostSeverity(state: HostState): AdminIncidentSeverity {
  switch (state) {
    case 'offline':
      return 'critical';
    case 'draining':
    case 'full':
      return 'warn';
    default:
      return 'info';
  }
}

/**
 * Whether a host's last report is recent enough to believe, computed locally.
 *
 * The SERVER's `online` flag is authoritative — it uses its own clock, which
 * is the one that decides dispatch. This exists so a list can go stale between
 * polls without waiting for the next refresh to say so.
 */
export function looksStale(host: AdminFleetHost, now: number = Date.now()): boolean {
  const at = parseTime(host.reportedAt);
  if (at == null) return true;
  return now - at >= HOST_STALE_AFTER_MS;
}

/**
 * Memory pressure as a percentage, or null when the host reported no budget.
 *
 * A host with `memBudgetMib: 0` never told us its cap. That is unknown, not
 * full, and rendering it as 100% would have an operator draining a healthy
 * box. (The backend's `hostIsDispatchable` makes the same distinction for
 * `runsMax === 0`.)
 */
export function memoryPct(host: AdminFleetHost): number | null {
  return pct(host.memReservedMib, host.memBudgetMib);
}

export function slotsPct(host: AdminFleetHost): number | null {
  return pct(host.runsLive, host.runsMax);
}

/**
 * How long a run took, wall clock.
 *
 * From `startedAt` — falling back to `createdAt`, so a run that never got off
 * the queue still reports how long it sat there — to `endedAt`, or to now while
 * it is still going.
 */
export function durationSeconds(run: AdminRunRow, now: number = Date.now()): number | null {
  const from = parseTime(run.startedAt) ?? parseTime(run.createdAt);
  if (from == null) return null;
  const to = parseTime(run.endedAt) ?? now;
  return Math.max(0, Math.round((to - from) / 1000));
}

/**
 * How long a run has been silent on the vsock — and, once it is over, how long
 * it was silent BEFORE it ended.
 *
 * The clock stops at `endedAt`. It used to run to `now` unconditionally, which
 * is right for a live run and meaningless for a finished one: a run that
 * completed yesterday reported 86,400 seconds idle and climbing. The column was
 * only ever readable on the handful of rows still in flight.
 *
 * Stopped, it answers the question that actually matters about a finished run:
 * how much of its life was silence at the end. A run reaped by the wedge
 * detector shows ~5 minutes there by definition, and a run that ended cleanly
 * shows a second or two — which is the difference between "this finished" and
 * "this was given up on", visible in one column.
 *
 * `lastActivity`, NOT `lastHeartbeat`. The distinction is load-bearing and the
 * fleet paid for it: wedge detection on heartbeats alone killed healthy runs
 * (HANDOFF failure #2), because a run busy enough not to heartbeat is still
 * plainly alive on any other frame. Falls back to the heartbeat only when the
 * fleet reported no activity at all.
 */
export function idleSeconds(run: AdminRunRow, now: number = Date.now()): number | null {
  const at = parseTime(run.lastActivity) ?? parseTime(run.lastHeartbeat);
  if (at == null) return null;
  const until = parseTime(run.endedAt) ?? now;
  return Math.max(0, Math.round((until - at) / 1000));
}

/**
 * Idle as a share of the run's duration, 0-100, or null when either is unknown.
 *
 * The proportion is what makes the number act on: nine minutes of silence is
 * routine on a two-hour run and is the whole story on a ten-minute one.
 */
export function idlePct(run: AdminRunRow, now: number = Date.now()): number | null {
  const idle = idleSeconds(run, now);
  const total = durationSeconds(run, now);
  if (idle == null || total == null || total <= 0) return null;
  return Math.min(100, Math.round((idle / total) * 100));
}

/** The fleet cancels a run silent for ~5 minutes. Warn before it does. */
export const WEDGE_WARN_SECONDS = 240;

/**
 * Whether a sandbox is asleep: suspended on its host, or hibernated to storage.
 *
 * Asleep is normal. A session's box sleeps between turns and costs no memory
 * and no slot, so its silence says nothing about whether it is stuck.
 */
export function isAsleep(run: AdminRunRow): boolean {
  return Boolean(run.sleep) || run.sandboxStatus === 'suspended';
}

/** How long a sleeping box has slept, or null when it is awake or the host did not say. */
export function sleepSeconds(run: AdminRunRow, now: number = Date.now()): number | null {
  if (!isAsleep(run)) return null;
  const since = parseTime(run.sleep?.since);
  return since == null ? null : Math.max(0, Math.round((now - since) / 1000));
}

/** The fleet states in which a box is awake and should be sending frames. */
const AWAKE_STATES = new Set(['starting', 'idle', 'busy', 'running']);

/**
 * Whether a run looks stuck.
 *
 * Only for a box that is awake (starting, idle or busy) and silent past the
 * threshold. A completed run stops sending frames by definition, and so does a
 * box that is asleep: the page used to read every suspended session as
 * "running" and flag all of them "wedged?", which made the flag mean nothing.
 *
 * A row with no fleet state word (an older backend, or task history) keeps the
 * old rule on the run status.
 */
export function looksWedged(run: AdminRunRow, now: number = Date.now()): boolean {
  if (isAsleep(run)) return false;
  if (run.sandboxStatus) {
    if (!AWAKE_STATES.has(run.sandboxStatus)) return false;
  } else if (run.status !== 'running' && run.status !== 'queued') {
    return false;
  }
  const idle = idleSeconds(run, now);
  return idle != null && idle >= WEDGE_WARN_SECONDS;
}

/** What the sandbox is for. An older backend sends no kind: a task id means a task. */
export function runKind(run: AdminRunRow): AdminRunKind {
  return run.kind ?? (run.taskId ? 'task' : 'unknown');
}

/** Whether a Talyn row claims the sandbox. An older backend sends only `orphan`. */
export function runClaim(run: AdminRunRow): AdminRunClaim {
  return run.claim ?? (run.orphan ? 'orphan' : 'active');
}

/** An orphan worth a warning: not a deploy self-test, which is supposed to happen. */
export function isRealOrphan(run: AdminRunRow): boolean {
  return runClaim(run) === 'orphan' && !run.selfTest;
}

/** The header counts on the Runs page. */
export interface RunCounts {
  running: number;
  asleep: number;
  superseded: number;
  orphaned: number;
  wedged: number;
}

export function countRuns(runs: AdminRunRow[], now: number = Date.now()): RunCounts {
  const counts: RunCounts = { running: 0, asleep: 0, superseded: 0, orphaned: 0, wedged: 0 };
  for (const run of runs) {
    if (isAsleep(run)) counts.asleep++;
    else if (!isTerminal(run.status) && run.status != null) counts.running++;
    if (runClaim(run) === 'superseded') counts.superseded++;
    if (isRealOrphan(run)) counts.orphaned++;
    if (looksWedged(run, now)) counts.wedged++;
  }
  return counts;
}

/**
 * The box's size in words: the named size when the memory matches one
 * ("Large · 12 GB"), else the memory, with the vCPUs when known.
 */
export function boxSizeLabel(run: Pick<AdminRunRow, 'memMib' | 'vcpuCount' | 'sandboxSize'>): string | null {
  const named = run.sandboxSize ? SANDBOX_SIZES[run.sandboxSize as keyof typeof SANDBOX_SIZES] : undefined;
  if (named && (run.memMib == null || run.memMib === named.memMib)) return named.label;
  const byMemory = Object.values(SANDBOX_SIZES).find((size) => size.memMib === run.memMib);
  if (byMemory) return byMemory.label;
  if (run.memMib == null) return null;
  return run.vcpuCount ? `${mib(run.memMib)} · ${run.vcpuCount} vCPU` : mib(run.memMib);
}

export function isTerminal(status: AdminRunRow['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Rank runs for display: the ones needing attention first.
 *
 * Orphans lead — a microVM with no task behind it is burning memory for
 * nobody, and it is the thing this page exists to catch. Then wedged runs,
 * then live ones, then history.
 */
export function runRank(run: AdminRunRow, now: number = Date.now()): number {
  if (runClaim(run) === 'orphan') return 0;
  if (looksWedged(run, now)) return 1;
  if (!isTerminal(run.status)) return 2;
  return 3;
}

export function sortRuns(runs: AdminRunRow[], now: number = Date.now()): AdminRunRow[] {
  return [...runs].sort((a, b) => {
    const rank = runRank(a, now) - runRank(b, now);
    if (rank !== 0) return rank;
    return (parseTime(b.createdAt) ?? 0) - (parseTime(a.createdAt) ?? 0);
  });
}

/** Disk free as a percentage of the golden store, when the host reports it. */
export function goldenFreePct(freePct: number | null | undefined): number | null {
  if (freePct == null || !Number.isFinite(freePct)) return null;
  return Math.max(0, Math.min(100, freePct));
}

/**
 * The fleet's GC starts evicting under this much free space.
 *
 * Mirrors `-golden-gc-low-pct 15`. Shown so an operator can see GC pressure
 * coming rather than discovering it from an eviction counter afterwards.
 */
export const GOLDEN_GC_LOW_PCT = 15;
