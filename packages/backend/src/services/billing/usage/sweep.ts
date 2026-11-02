import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { sandboxSizeForResources, UNATTENDED_SANDBOX_SIZE, type SandboxSize, type UsageSubjectKind } from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import { prCodeReviewRuns, tasks, workbenches, workspaces } from '../../../db/schema.js';
import { debugBus } from '../../debugBus.js';
import { setWorkbenchSandboxState } from '../../workbenches/sandboxState.js';
import { listFleetHosts } from '../../fleetHosts.js';
import { FleetClient, type FleetSandbox, type FleetSandboxStatus } from '../../selfHosted/client.js';
import { fleetApiToken, fleetGatewayToken, fleetPinnedEndpoint } from '../../selfHosted/credentials.js';
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
 *   at now, when its id maps to a Talyn task, review unit or workbench.
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

type SweptBox = Pick<FleetSandbox, 'id' | 'status' | 'endedAt' | 'memMib' | 'vcpuCount'> & { suspendedAt?: string };

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
          sql`split_part(${workbenches.sandboxId}, '--', 1) = ${sandboxId}`,
          sql`${workbenches.settings} ->> 'fleetSandboxId' = ${sandboxId}`,
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The size a box runs at: from its booted resources, else the default for its kind. */
export function sizeForBox(box: Pick<FleetSandbox, 'memMib' | 'vcpuCount'>, kind: UsageSubjectKind): SandboxSize {
  const fromResources = sandboxSizeForResources(box.memMib, box.vcpuCount ? box.vcpuCount * 1000 : undefined);
  return fromResources ?? (kind === 'review_unit' ? UNATTENDED_SANDBOX_SIZE : 'standard');
}

export interface SweepResult {
  opened: number;
  closed: number;
  /** Hosts whose list failed this tick. */
  listErrors: number;
}

export class UsageSweep {
  /** Consecutive ticks each sandbox with an open interval was missing from every list. */
  private missing = new Map<string, number>();

  constructor(private readonly clients: () => Promise<TenantClient[]> = tenantClients) {}

  async run(now = new Date()): Promise<SweepResult> {
    const open = await openIntervalsQuery();
    const openBySandbox = new Map<string, IntervalRow>(open.map((i) => [i.sandboxId, i]));
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
        if (!gateway) {
          boxes.set(ref.id, ref as FleetSandbox);
          continue;
        }
        // Read through the gateway only what can matter: boxes we meter, and
        // Talyn boxes that might be running without an interval.
        if (!openBySandbox.has(ref.id) && !subjectForSandboxId(ref.id)) continue;
        try {
          boxes.set(ref.id, (await client.getSandbox(ref.id)).sandbox);
        } catch (error) {
          listErrors += 1;
          debugBus.recordEvent({ service: 'billing', action: 'usage_sweep_read_failed', summary: `Could not read ${ref.id}`, ok: false, error });
        }
      }
    }

    let closed = 0;
    for (const interval of open) {
      const box = boxes.get(interval.sandboxId);
      let missingTicks = 0;
      if (box) {
        this.missing.delete(interval.sandboxId);
      } else if (listErrors === 0) {
        missingTicks = (this.missing.get(interval.sandboxId) ?? 0) + 1;
        this.missing.set(interval.sandboxId, missingTicks);
      }
      const decision = decideOpenInterval(box, missingTicks, now);
      if (!decision.close) continue;
      if (await markIntervalClosed(interval.sandboxId, decision.at, decision.reason)) {
        closed += 1;
        this.missing.delete(interval.sandboxId);
        if (interval.subjectKind === 'workbench' && decision.reason === 'suspended') {
          await setWorkbenchSandboxState({ workbenchId: interval.subjectId }, 'running', 'suspended');
        }
      }
    }
    for (const sandboxId of this.missing.keys()) {
      if (!openBySandbox.has(sandboxId)) this.missing.delete(sandboxId);
    }

    let opened = 0;
    for (const box of boxes.values()) {
      if (!RUNNING.has(box.status) || openBySandbox.has(box.id)) continue;
      const subject = subjectForSandboxId(box.id);
      if (!subject) continue;
      const resolved = await resolveSubject(subject.kind, subject.key, box.id);
      if (!resolved) continue;
      const inserted = await insertOpenInterval({
        ownerId: resolved.ownerId,
        workspaceId: resolved.workspaceId,
        subjectKind: subject.kind,
        subjectId: resolved.subjectId,
        sandboxId: box.id,
        size: sizeForBox(box, subject.kind),
        startedAt: now,
      });
      if (!inserted) continue;
      opened += 1;
      if (subject.kind === 'workbench') await setWorkbenchSandboxState({ workbenchId: resolved.subjectId }, 'suspended', 'running');
    }
    return { opened, closed, listErrors };
  }
}
