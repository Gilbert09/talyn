import type { AdminRunIndex, AdminRunRow, AdminRunSleep, AdminRunStatus } from '@talyn/shared';
import type { FleetSandbox } from '../selfHosted/client.js';
import { cloudStatusForSandbox } from '../selfHosted/poller.js';
import { listAdminTasks } from './queries.js';
import { liveFleetSandboxes } from './fleetProxy.js';
import {
  classifySandbox,
  loadSandboxClaims,
  logicalSandboxId,
  parseSandboxId,
  type SandboxClassification,
} from './sandboxClaims.js';

/**
 * "What is happening on the fleet", joined from two sources that each know
 * something the other does not.
 *
 * The fleet's record store is IN-MEMORY (plus a per-record JSON ledger that
 * exists only so a crashed supervisor can adopt in-flight VMs), so history
 * dies with the process. The durable record is the `tasks` row. Neither alone
 * answers the question:
 *
 *   - `orphan: true` — a sandbox live on a host that no Talyn row (task,
 *     session, thread or review unit, of any status) claims. A microVM burning
 *     memory for nobody, invisible from either side alone.
 *   - `live: null` on a non-terminal task — the task believes it is running
 *     and the host has never heard of it. Usually a fleetd restart that lost
 *     the record, which is precisely what the re-credentialing path exists for.
 *
 * The live side is `GET /v1/sandboxes` per host — the merged fleet has no run
 * list any more, so the "runs" this page shows ARE the hosts' sandboxes,
 * translated back into the run-status vocabulary the console has always
 * spoken (see cloudStatusForSandbox).
 *
 * The join key is the deterministic sandbox id. sandboxClaims.ts reads the
 * three id schemes Talyn makes and finds the row behind each.
 */

/** The METADATA fallback: `cloudTask.status` is written by the poller in the
 *  legacy run vocabulary, so this only filters, never translates. */
function toStatus(raw: string | null | undefined): AdminRunStatus | null {
  switch (raw) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return raw;
    default:
      return null;
  }
}

function iso(value: string | undefined): string | null {
  if (!value) return null;
  // fleetd zero-values a time.Time as year 1 rather than omitting it in some
  // paths; a date that old is "never", not a timestamp worth rendering.
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return null;
  return date.toISOString();
}

/**
 * A live fleetd sandbox, as the console's row shape.
 *
 * Exported so the single-run route returns the SAME shape the list does —
 * two run shapes would mean the detail page reimplementing every derivation
 * (idle time, wedge detection, status pill) against a different set of field
 * names.
 *
 * `orphan: true` by default because this builds from the live side alone; the
 * list overrides it when a task row claims the sandbox.
 */
export function adminRunFromFleet(sandbox: FleetSandbox, host: string | null): AdminRunRow {
  const extra = sandbox as FleetSandbox & SandboxExtras;
  const parsed = parseSandboxId(sandbox.id);
  return {
    runId: sandbox.id,
    host,
    taskId: null,
    workspaceId: sandbox.workspaceId ?? null,
    ownerEmail: null,
    repo: sandbox.task?.repo ?? extra.repo ?? null,
    kind: parsed.kind === 'workbench' ? 'session' : parsed.kind,
    claim: 'orphan',
    supersededReason: null,
    title: null,
    workbenchId: null,
    workspaceName: null,
    sandboxStatus: sandbox.status ?? null,
    sleep: sleepOf(sandbox),
    vcpuCount: typeof sandbox.vcpuCount === 'number' ? sandbox.vcpuCount : null,
    diskMib: typeof sandbox.diskMib === 'number' && sandbox.diskMib > 0 ? sandbox.diskMib : null,
    sandboxSize: null,
    status: cloudStatusForSandbox(sandbox),
    phase: sandbox.phase ?? null,
    adopted: Boolean(sandbox.adopted),
    slot: typeof sandbox.slot === 'number' ? sandbox.slot : null,
    goldenLayer: sandbox.goldenLayer ?? null,
    createdAt: iso(sandbox.createdAt),
    startedAt: iso(sandbox.startedAt),
    endedAt: iso(sandbox.endedAt),
    deadline: iso(sandbox.deadline),
    lastHeartbeat: iso(sandbox.lastHeartbeat),
    lastActivity: iso(sandbox.lastActivity),
    costUsd: typeof sandbox.costUsd === 'number' ? sandbox.costUsd : null,
    memUsedMib: typeof sandbox.memUsedMib === 'number' ? sandbox.memUsedMib : null,
    memMib: typeof sandbox.memMib === 'number' ? sandbox.memMib : null,
    prUrl: sandbox.prUrl ?? initialTaskPrUrl(sandbox),
    error: sandbox.error ?? null,
    orphan: true,
    selfTest: Boolean(sandbox.task?.selfTest),
  };
}

/**
 * Sandbox fields newer than Talyn's FleetSandbox type (yas openapi `Sandbox`).
 * Read here and not added to the client type, which other work owns.
 */
interface SandboxExtras {
  repo?: string;
  suspendedAt?: string;
  suspendUploaded?: boolean;
  suspendUploadError?: string;
}

/**
 * Where a suspended sandbox sleeps, or null when it is awake.
 *
 * `storage` once a complete copy is in object storage (the fleet sets
 * `suspendUploaded` only after the manifest lands), `local` before that. A box
 * asleep is normal: it costs no memory and no slot, and its silence is not a
 * wedge. The Runs page used to read every suspended box as `running` with a
 * growing idle time, and flagged all of them "wedged?".
 */
export function sleepOf(sandbox: FleetSandbox): AdminRunSleep | null {
  if (sandbox.status !== 'suspended') return null;
  const extra = sandbox as FleetSandbox & SandboxExtras;
  const kind = sandbox.suspendKind;
  return {
    kind: extra.suspendUploaded ? 'storage' : 'local',
    since: iso(extra.suspendedAt),
    suspendKind: kind === 'memory' || kind === 'rootfs' ? kind : null,
    uploadError: extra.suspendUploadError || null,
  };
}

/**
 * Put what the claiming row knows onto a live row.
 *
 * The host the fleet named wins over the one Talyn recorded: a sleeping box can
 * wake on another host, and the recorded host is where it was CREATED.
 */
export function applyClassification(row: AdminRunRow, c: SandboxClassification): AdminRunRow {
  const out: AdminRunRow = {
    ...row,
    kind: c.kind,
    claim: c.claim,
    supersededReason: c.supersededReason,
    orphan: c.claim === 'orphan',
  };
  if (c.task) {
    out.taskId = c.task.id;
    out.workspaceId = c.task.workspaceId;
    out.workspaceName = c.task.workspaceName;
    out.ownerEmail = c.task.ownerEmail;
    out.title = c.task.title;
    out.host = row.host ?? c.task.fleetHost;
    out.costUsd = row.costUsd ?? c.task.costUsd;
  }
  if (c.workbench) {
    out.workbenchId = c.workbench.id;
    out.workspaceId = c.workbench.workspaceId;
    out.workspaceName = c.workbench.workspaceName;
    out.ownerEmail = c.workbench.ownerEmail;
    out.title = c.workbench.title || c.workbench.name;
    out.repo = c.workbench.repoFullName || row.repo;
    out.sandboxSize = c.workbench.sandboxSize;
    out.host = row.host ?? c.workbench.fleetHost;
  }
  if (c.review) {
    out.workspaceId = c.review.workspaceId;
    out.workspaceName = c.review.workspaceName;
    out.ownerEmail = c.review.ownerEmail;
    out.title = `Code review${c.review.lens ? `: ${c.review.lens}` : ''} (${c.review.kind})`;
    out.host = row.host ?? c.review.host;
  }
  return out;
}

/** The PR the initial task opened, when the record reports it there rather
 *  than on the sandbox itself. */
function initialTaskPrUrl(sandbox: FleetSandbox): string | null {
  return sandbox.tasks?.[0]?.prUrl ?? null;
}

/**
 * Newest first, on the timestamp the row actually has.
 *
 * `startedAt` is the one an operator reads as "when did this run", but a queued
 * run has none — falling back to `createdAt` keeps it beside its neighbours
 * instead of at the bottom, which is where a bare `startedAt ?? 0` would put
 * the run most likely to need attention.
 */
function byRecency(a: AdminRunRow, b: AdminRunRow): number {
  const at = Date.parse(a.startedAt ?? a.createdAt ?? '') || 0;
  const bt = Date.parse(b.startedAt ?? b.createdAt ?? '') || 0;
  if (at !== bt) return bt - at;
  // Stable for equal timestamps so the list does not shuffle between polls.
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

export interface AdminRunFilters {
  host?: unknown;
  status?: unknown;
  kind?: unknown;
  owner?: unknown;
  limit?: unknown;
  before?: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Whether a row passes the page's filters. Applied to the live rows in memory. */
export function runMatches(row: AdminRunRow, filters: { host: string; status: string; kind: string; owner: string }): boolean {
  if (filters.host && row.host !== filters.host) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.kind && (row.kind ?? 'task') !== filters.kind) return false;
  if (filters.owner && !(row.ownerEmail ?? '').toLowerCase().includes(filters.owner.toLowerCase())) return false;
  return true;
}

/**
 * Every live sandbox, classified, plus the durable task history.
 *
 * Live rows come first in the sense that they are always present: they are not
 * paginated (there are never many, and burying an orphan on page four would
 * defeat the point), so they appear on the first page only. Every live row is
 * classified against tasks, workbenches AND review units, so a session box is a
 * session with an owner, not an orphan (see sandboxClaims.ts).
 *
 * History rows are task rows only: a task's record outlives its sandbox, and a
 * session's history is on the Sessions page.
 */
export async function listAdminRuns(filters: AdminRunFilters): Promise<AdminRunIndex> {
  const f = { host: str(filters.host), status: str(filters.status), kind: str(filters.kind), owner: str(filters.owner) };
  const firstPage = !str(filters.before);
  const wantHistory = !f.kind || f.kind === 'task';

  const [page, { live, degraded }] = await Promise.all([
    wantHistory
      ? listAdminTasks({
          host: f.host || undefined,
          status: undefined,
          ownerEmail: f.owner || undefined,
          limit: filters.limit,
          before: filters.before,
          provider: 'selfhosted',
        })
      : Promise.resolve({ items: [], nextCursor: null }),
    // Not a host fan-out any more. Through the gateway a sandbox belongs to a
    // TENANT, and this backend's own FLEET_API_TOKEN resolves to the empty one
    // — so asking each box directly returns nothing for every run the gateway
    // placed. See liveFleetSandboxes.
    firstPage ? liveFleetSandboxes() : Promise.resolve({ live: [], degraded: [] }),
  ]);

  const claims = await loadSandboxClaims(live.map((entry) => entry.sandbox.id));
  const liveRows = live.map(({ sandbox, host }) =>
    applyClassification(adminRunFromFleet(sandbox, host), classifySandbox(sandbox.id, claims)),
  );
  const liveIds = new Set(liveRows.map((r) => r.runId));
  const liveLogical = new Set(liveRows.map((r) => logicalSandboxId(r.runId)));

  const historyRows: AdminRunRow[] = page.items
    .map((task) => {
      const runId = task.remoteRunId ?? `talyn-${task.id}`;
      return { task, runId };
    })
    // The live row already carries this task, with fresher data.
    .filter(({ runId }) => !liveIds.has(runId) && !liveLogical.has(logicalSandboxId(runId)))
    .map(({ task, runId }) => ({
      runId,
      host: task.fleetHost ?? null,
      taskId: task.id,
      workspaceId: task.workspaceId,
      ownerEmail: task.ownerEmail,
      repo: null,
      kind: 'task' as const,
      claim: 'active' as const,
      supersededReason: null,
      title: task.title,
      workbenchId: null,
      workspaceName: task.workspaceName,
      sandboxStatus: null,
      sleep: null,
      vcpuCount: null,
      diskMib: null,
      sandboxSize: null,
      status: toStatus(task.cloudStatus),
      phase: task.phase ?? null,
      adopted: false,
      slot: null,
      goldenLayer: null,
      createdAt: task.createdAt,
      startedAt: null,
      endedAt: task.completedAt,
      deadline: null,
      lastHeartbeat: null,
      lastActivity: null,
      costUsd: task.costUsd,
      // No task-side fallback: only the live host knows what a sandbox is
      // using right now, and a stale figure would be worse than an honest
      // blank.
      memUsedMib: null,
      memMib: null,
      prUrl: null,
      error: null,
      orphan: false,
      selfTest: false,
    }));

  // Merged by time, not concatenated: a run that started a minute ago must not
  // sort below an hour-old orphan. Orphans keep their tinted row and their
  // count in the header, which is what makes them findable.
  const items = [...liveRows.filter((row) => runMatches(row, f)), ...historyRows.filter((row) => runMatches(row, f))].sort(
    byRecency,
  );

  return { items, nextCursor: page.nextCursor, degraded };
}
