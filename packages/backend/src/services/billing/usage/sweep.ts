import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  billedSizeFor,
  isSandboxSize,
  sandboxSizeForResources,
  SIZE_WEIGHT,
  UNATTENDED_SANDBOX_SIZE,
  type SandboxSize,
  type UsageSubjectKind,
} from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import { prCodeReviewRuns, tasks, workbenches, workspaces } from '../../../db/schema.js';
import { debugBus } from '../../debugBus.js';
import { setWorkbenchSandboxState } from '../../workbenches/sandboxState.js';
import { currentBoxPayer } from '../../workbenches/store.js';
import { listFleetHosts } from '../../fleetHosts.js';
import { FleetClient, type FleetSandbox, type FleetSandboxStatus } from '../../selfHosted/client.js';
import { fleetApiToken, fleetGatewayToken, fleetPinnedEndpoint } from '../../selfHosted/credentials.js';
import { pruneResourceSamples, recordResourceSamples, sampleFromFleet, type ResourceSample } from '../../workbenches/resourceSamples.js';
import { insertOpenInterval, markIntervalClosed, openIntervalsQuery, type EndReason, type IntervalRow } from './intervals.js';

/**
 * Hooks give precision; this sweep gives truth. Every minute it compares the
 * open intervals with what the fleet reports, so a missed hook, a deploy
 * overlap or a fleet-side idle suspend cannot leak billing:
 *
 * - an open interval whose box is `suspended` closes at the box's
 *   `suspendedAt` (else now); a terminal box closes at its `endedAt`; a
 *   `queued` box is not running, so it closes too;
 * - an open interval whose box no host lists closes after two clean ticks in
 *   a row (`'sweep'`), never on a tick where a host listing failed;
 * - a running box (`starting | idle | busy`) with no open interval opens one
 *   at now, when its id maps to a Talyn task, review unit or workbench;
 * - a running box bills the size its measured memory needs, up to the size it
 *   booted at ({@link billedSizeFor}). When that size changes, the interval
 *   closes (`'resize'`) and a new one opens at the new size.
 *
 * The same list also gives each running session box's CPU and memory sample
 * for the Sandbox panel's chart, so the chart costs no extra fleet read.
 */

export interface TenantClient {
  client: FleetClient;
  /** A gateway's list carries no status; each box is read with `getSandbox`. */
  gateway: boolean;
}

/** The fleet clients that together list every Talyn box (the reaper's pattern). */
export async function tenantClients(): Promise<TenantClient[]> {
  const endpoint = fleetPinnedEndpoint();
  if (endpoint) {
    const token = fleetGatewayToken();
    return token ? [{ client: new FleetClient(endpoint, token), gateway: true }] : [];
  }
  const token = fleetApiToken();
  if (!token) return [];
  return (await listFleetHosts())
    .filter((host) => host.apiEndpoint)
    .map((host) => ({ client: new FleetClient(host.apiEndpoint!, token), gateway: false }));
}

const RUNNING: ReadonlySet<FleetSandboxStatus> = new Set(['starting', 'idle', 'busy']);
const ENDED: ReadonlySet<FleetSandboxStatus> = new Set(['stopped', 'failed', 'cancelled']);

/** Ticks in a row a box must be missing from every list before its interval closes. */
export const MISSING_TICKS_TO_CLOSE = 2;

/**
 * Ticks in a row a box must measure lighter than its interval before the
 * interval moves down. The sweep reads memory once a minute, so it does not
 * see a short peak between two reads. Five lighter minutes stop a build whose
 * memory drops for a moment from billing at the small size, and they limit how
 * many intervals a box makes. The count is in memory: a deploy loses it, which
 * only delays a move down. That bills the higher size, the safe direction.
 */
export const DOWNSIZE_AFTER_TICKS = 5;

/** The longest time before now that a resize reprices. */
const RESIZE_LOOKBACK_MS = 60_000;

type SweptBox = Pick<FleetSandbox, 'id' | 'status' | 'endedAt' | 'memMib' | 'vcpuCount' | 'milliVcpu' | 'memUsedMib' | 'cpuSeconds'> & {
  suspendedAt?: string;
};

/** What should happen to an open interval, given its box (or its absence). Pure. */
export function decideOpenInterval(
  box: SweptBox | undefined,
  missingTicks: number,
  now: Date,
): { close: false } | { close: true; at: Date; reason: EndReason } {
  if (!box) {
    return missingTicks >= MISSING_TICKS_TO_CLOSE ? { close: true, at: now, reason: 'sweep' } : { close: false };
  }
  if (box.status === 'suspended') return { close: true, at: parseTime(box.suspendedAt) ?? now, reason: 'suspended' };
  if (ENDED.has(box.status)) return { close: true, at: parseTime(box.endedAt) ?? now, reason: 'terminal' };
  if (box.status === 'queued') return { close: true, at: now, reason: 'sweep' };
  return { close: false };
}

function parseTime(value: string | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The id Talyn gave a box. A fleet gateway lists a box under its own id,
 * `<talyn id>--<suffix>` (the reaper's `logicalId`), while the hooks open an
 * interval under Talyn's id. Keying on either alone counted one box twice.
 */
export function logicalSandboxId(id: string): string {
  return id.split('--')[0];
}

/** The subject a Talyn box id names, from the deterministic id formats. Pure. */
export function subjectForSandboxId(id: string): { kind: UsageSubjectKind; key: string } | null {
  if (id.startsWith('talyn-wb-')) return { kind: 'workbench', key: id };
  const review = /^talyn-rev-(.+?)(?:-r\d+)?$/.exec(id);
  if (review) return { kind: 'review_unit', key: review[1] };
  const task = /^talyn-(.+?)(?:-r\d+)?$/.exec(id);
  if (task) return { kind: 'task', key: task[1] };
  return null;
}

interface ResolvedSubject {
  ownerId: string;
  workspaceId: string;
  subjectId: string;
  /** A teammate who pays for a session box. `ownerId` is then that teammate. */
  payerUserId?: string | null;
}

async function resolveSubject(kind: UsageSubjectKind, key: string, sandboxId: string): Promise<ResolvedSubject | null> {
  const db = getPoolDbClient();
  if (kind === 'task') {
    const [row] = await db
      .select({ subjectId: tasks.id, workspaceId: tasks.workspaceId, ownerId: workspaces.ownerId })
      .from(tasks)
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .where(eq(tasks.id, key))
      .limit(1);
    return row ?? null;
  }
  if (kind === 'review_unit') {
    const [row] = await db
      .select({ subjectId: prCodeReviewRuns.id, workspaceId: prCodeReviewRuns.workspaceId, ownerId: workspaces.ownerId })
      .from(prCodeReviewRuns)
      .innerJoin(workspaces, eq(workspaces.id, prCodeReviewRuns.workspaceId))
      .where(eq(prCodeReviewRuns.id, key))
      .limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select({ subjectId: workbenches.id, workspaceId: workbenches.workspaceId, ownerId: workspaces.ownerId })
    .from(workbenches)
    .innerJoin(workspaces, eq(workspaces.id, workbenches.workspaceId))
    .where(
      and(
        isNull(workbenches.archivedAt),
        or(
          sql`split_part(${workbenches.sandboxId}, '--', 1) = ${logicalSandboxId(sandboxId)}`,
          sql`${workbenches.settings} ->> 'fleetSandboxId' = ${sandboxId}`,
        ),
      ),
    )
    .limit(1);
  if (!row) return null;
  // A session box bills the payer of its latest turn, else the workspace owner.
  const payer = await currentBoxPayer(row.subjectId);
  return payer ? { ...row, ownerId: payer.userId, payerUserId: payer.userId } : row;
}

/** The size a box booted at: from its resources, else the default for its kind. */
export function sizeForBox(box: Pick<FleetSandbox, 'memMib' | 'vcpuCount'>, kind: UsageSubjectKind): SandboxSize {
  const fromResources = sandboxSizeForResources(box.memMib, box.vcpuCount ? box.vcpuCount * 1000 : undefined);
  return fromResources ?? (kind === 'review_unit' ? UNATTENDED_SANDBOX_SIZE : 'standard');
}

/**
 * What to do with an open interval of a running box, given the size it bills
 * at now. Pure. `lighterTicks` counts the ticks in a row before this one that
 * measured lighter; `lighterSize` is the heaviest size those ticks measured.
 */
export function decideResize(
  current: SandboxSize,
  measured: SandboxSize,
  lighter: { ticks: number; size: SandboxSize } | undefined,
): { resize: SandboxSize } | { lighter: { ticks: number; size: SandboxSize } | null } {
  if (SIZE_WEIGHT[measured] > SIZE_WEIGHT[current]) return { resize: measured };
  if (SIZE_WEIGHT[measured] === SIZE_WEIGHT[current]) return { lighter: null };
  const ticks = (lighter?.ticks ?? 0) + 1;
  // Bill the heaviest size the lighter run measured, never the last one alone.
  const size = lighter && SIZE_WEIGHT[lighter.size] > SIZE_WEIGHT[measured] ? lighter.size : measured;
  return ticks >= DOWNSIZE_AFTER_TICKS ? { resize: size } : { lighter: { ticks, size } };
}

export interface SweepResult {
  opened: number;
  closed: number;
  /** Intervals closed and opened again at a new measured size. */
  resized: number;
  /** Hosts whose list failed this tick. */
  listErrors: number;
}

export class UsageSweep {
  /** Consecutive ticks each sandbox with an open interval was missing from every list. */
  private missing = new Map<string, number>();
  /** Per sandbox: ticks in a row the box measured lighter than its interval. */
  private lighter = new Map<string, { ticks: number; size: SandboxSize }>();

  constructor(private readonly clients: () => Promise<TenantClient[]> = tenantClients) {}

  async run(now = new Date()): Promise<SweepResult> {
    const all = await openIntervalsQuery();
    // One open interval per box. A duplicate (the same box under its two ids)
    // closes at its own start, so it bills nothing more.
    const openBySandbox = new Map<string, IntervalRow>();
    let closed = 0;
    for (const interval of [...all].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())) {
      const key = logicalSandboxId(interval.sandboxId);
      if (!openBySandbox.has(key)) {
        openBySandbox.set(key, interval);
      } else if (await markIntervalClosed(interval.sandboxId, interval.startedAt, 'sweep')) {
        closed += 1;
      }
    }
    const open = [...openBySandbox.values()];
    const boxes = new Map<string, SweptBox>();
    let listErrors = 0;

    for (const { client, gateway } of await this.clients()) {
      let listed;
      try {
        listed = gateway ? await client.listGatewaySandboxes() : await client.listSandboxes();
      } catch (error) {
        listErrors += 1;
        debugBus.recordEvent({ service: 'billing', action: 'usage_sweep_list_failed', summary: 'A fleet host list failed', ok: false, error });
        continue;
      }
      for (const ref of listed.sandboxes) {
        const key = logicalSandboxId(ref.id);
        if (!gateway) {
          boxes.set(key, ref as FleetSandbox);
          continue;
        }
        // Read through the gateway only what can matter: boxes we meter, and
        // Talyn boxes that might be running without an interval.
        if (!openBySandbox.has(key) && !subjectForSandboxId(key)) continue;
        try {
          boxes.set(key, (await client.getSandbox(ref.id)).sandbox);
        } catch (error) {
          listErrors += 1;
          debugBus.recordEvent({ service: 'billing', action: 'usage_sweep_read_failed', summary: `Could not read ${ref.id}`, ok: false, error });
        }
      }
    }

    let resized = 0;
    for (const interval of open) {
      const key = logicalSandboxId(interval.sandboxId);
      const box = boxes.get(key);
      let missingTicks = 0;
      if (box) {
        this.missing.delete(key);
      } else if (listErrors === 0) {
        missingTicks = (this.missing.get(key) ?? 0) + 1;
        this.missing.set(key, missingTicks);
      }
      const decision = decideOpenInterval(box, missingTicks, now);
      if (!decision.close) {
        if (box && RUNNING.has(box.status) && (await this.resizeIfNeeded(interval, box, now))) resized += 1;
        continue;
      }
      if (await markIntervalClosed(interval.sandboxId, decision.at, decision.reason)) {
        closed += 1;
        this.missing.delete(key);
        this.lighter.delete(key);
        if (interval.subjectKind === 'workbench' && decision.reason === 'suspended') {
          await setWorkbenchSandboxState({ workbenchId: interval.subjectId }, 'running', 'suspended');
        }
      }
    }
    for (const sandboxId of this.missing.keys()) {
      if (!openBySandbox.has(sandboxId)) this.missing.delete(sandboxId);
    }
    for (const sandboxId of this.lighter.keys()) {
      if (!openBySandbox.has(sandboxId)) this.lighter.delete(sandboxId);
    }

    const sessionBoxes = new Map<string, string>();
    for (const interval of open) {
      if (interval.subjectKind === 'workbench') sessionBoxes.set(logicalSandboxId(interval.sandboxId), interval.subjectId);
    }

    let opened = 0;
    for (const [sandboxId, box] of boxes) {
      if (!RUNNING.has(box.status) || openBySandbox.has(sandboxId)) continue;
      const subject = subjectForSandboxId(sandboxId);
      if (!subject) continue;
      const resolved = await resolveSubject(subject.kind, subject.key, box.id);
      if (!resolved) continue;
      const inserted = await insertOpenInterval({
        ownerId: resolved.ownerId,
        workspaceId: resolved.workspaceId,
        subjectKind: subject.kind,
        subjectId: resolved.subjectId,
        sandboxId,
        size: billedSizeFor(sizeForBox(box, subject.kind), box.memUsedMib),
        startedAt: now,
        payerUserId: resolved.payerUserId ?? null,
      });
      if (subject.kind === 'workbench') sessionBoxes.set(sandboxId, resolved.subjectId);
      if (!inserted) continue;
      opened += 1;
      if (subject.kind === 'workbench') await setWorkbenchSandboxState({ workbenchId: resolved.subjectId }, 'suspended', 'running');
    }

    await this.recordSamples(boxes, sessionBoxes, now);
    return { opened, closed, resized, listErrors };
  }

  /**
   * Move a running box's interval to the size its memory needs now. A heavier
   * size moves at once; a lighter one after {@link DOWNSIZE_AFTER_TICKS}. A box
   * that reports no memory figure, or no resources to name its booted size,
   * keeps its interval. True when the interval moved.
   */
  private async resizeIfNeeded(interval: IntervalRow, box: SweptBox, now: Date): Promise<boolean> {
    const key = logicalSandboxId(interval.sandboxId);
    const current = interval.size;
    const booted = sandboxSizeForResources(box.memMib, box.vcpuCount ? box.vcpuCount * 1000 : box.milliVcpu);
    const memUsedMib = box.memUsedMib;
    if (!booted || !isSandboxSize(current) || typeof memUsedMib !== 'number' || !Number.isFinite(memUsedMib) || memUsedMib <= 0) {
      this.lighter.delete(key);
      return false;
    }
    const decision = decideResize(current, billedSizeFor(booted, memUsedMib), this.lighter.get(key));
    if (!('resize' in decision)) {
      if (decision.lighter) this.lighter.set(key, decision.lighter);
      else this.lighter.delete(key);
      return false;
    }
    this.lighter.delete(key);
    // Reprice at most the last minute: the time since the last charge, which
    // the meter charges right after this sweep.
    const lookback = new Date(now.getTime() - RESIZE_LOOKBACK_MS);
    const splitAt = interval.billedThrough.getTime() > lookback.getTime() ? interval.billedThrough : lookback;
    const closedRow = await markIntervalClosed(interval.sandboxId, splitAt, 'resize', interval.id);
    if (!closedRow) return false;
    // A charge can move the cursor after the read above; the close then ends
    // at the cursor, and the next interval must start there too.
    const startedAt = closedRow.endedAt ?? splitAt;
    await insertOpenInterval({
      ownerId: interval.ownerId,
      workspaceId: interval.workspaceId,
      subjectKind: interval.subjectKind as UsageSubjectKind,
      subjectId: interval.subjectId,
      sandboxId: interval.sandboxId,
      size: decision.resize,
      startedAt,
      payerUserId: interval.payerUserId,
    });
    debugBus.recordEvent({
      service: 'billing',
      action: 'usage_resize',
      summary: `Billed ${interval.sandboxId} as ${decision.resize} (was ${current})`,
      ok: true,
      meta: { sandboxId: interval.sandboxId, from: current, to: decision.resize, memUsedMib },
      ...(interval.workspaceId ? { workspaceId: interval.workspaceId } : {}),
    });
    return true;
  }

  /** A failure here costs one chart point, never a bill. */
  private async recordSamples(boxes: Map<string, SweptBox>, sessionBoxes: Map<string, string>, now: Date): Promise<void> {
    const rows: ResourceSample[] = [];
    for (const [sandboxId, workbenchId] of sessionBoxes) {
      const box = boxes.get(sandboxId);
      if (!box || !RUNNING.has(box.status)) continue;
      const sample = sampleFromFleet(workbenchId, box, now);
      if (sample) rows.push(sample);
    }
    try {
      await recordResourceSamples(rows);
      await pruneResourceSamples(now);
    } catch (error) {
      debugBus.recordEvent({ service: 'billing', action: 'resource_samples_failed', summary: 'Could not store box resource samples', ok: false, error });
    }
  }
}
