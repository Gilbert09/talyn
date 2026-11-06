import type { SandboxSize, UsageSubjectKind } from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { debugBus } from '../debugBus.js';
import { ownerOfWorkspace } from '../workflows/owner.js';
import { closeInterval, openInterval, type EndReason } from './usage/index.js';

/**
 * The lifecycle hooks that feed the usage meter: every place Talyn starts,
 * wakes, suspends or removes a fleet box calls one of these.
 *
 * Two rules hold for every call:
 *
 * - **A meter failure never fails the caller.** A box that runs unmetered for
 *   a minute is a billing gap the meter's sweep closes; a dispatch, a turn or
 *   an archive that fails because the ledger hiccuped is a broken product.
 *   Errors go to the debug bus and the call returns.
 * - **Calls are idempotent.** An open while one is open does nothing, and a
 *   close with nothing open does nothing (the ledger's own contract), so a
 *   hook may fire twice on a retried path.
 *
 * The writes run outside any request scope: the ledger tables are
 * backend-pool-only, and a request's transaction must not carry them.
 *
 * PostHog Code runs are never metered. Only fleet create and wake paths call
 * {@link meterBoxOpened}.
 */

/** A workspace's owner never changes in practice; a short cache saves a read per hook. */
const OWNER_TTL_MS = 10 * 60_000;
const owners = new Map<string, { ownerId: string; expiresAt: number }>();

export function resetUsageHookCacheForTests(): void {
  owners.clear();
}

async function ownerFor(workspaceId: string): Promise<string | null> {
  const hit = owners.get(workspaceId);
  if (hit && hit.expiresAt > Date.now()) return hit.ownerId;
  const ownerId = await ownerOfWorkspace(workspaceId);
  if (ownerId) owners.set(workspaceId, { ownerId, expiresAt: Date.now() + OWNER_TTL_MS });
  return ownerId;
}

function recordFailure(action: string, sandboxId: string, err: unknown, workspaceId?: string | null): void {
  console.warn(`[usage-meter] ${action} for sandbox ${sandboxId} failed:`, err instanceof Error ? err.message : err);
  debugBus.recordEvent({
    service: 'usage-meter',
    action,
    summary: `${action} for sandbox ${sandboxId} failed; the meter sweep reconciles it.`,
    ok: false,
    error: err,
    meta: { sandboxId },
    ...(workspaceId ? { workspaceId } : {}),
  });
}

export interface MeterOpenInput {
  workspaceId: string;
  /** Known to the caller already; otherwise read from the workspace. */
  ownerId?: string | null;
  subjectKind: UsageSubjectKind;
  subjectId: string;
  sandboxId: string;
  size: SandboxSize;
  startedAt?: Date;
  /** A teammate who pays for the box; `ownerId` should then be the same user. */
  payerUserId?: string | null;
}

/** A box started or woke. Never throws. */
export async function meterBoxOpened(input: MeterOpenInput): Promise<void> {
  try {
    await runWithoutScope(async () => {
      const ownerId = input.ownerId ?? (await ownerFor(input.workspaceId));
      if (!ownerId) throw new Error(`workspace ${input.workspaceId} has no owner`);
      await openInterval({
        ownerId,
        workspaceId: input.workspaceId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        sandboxId: input.sandboxId,
        size: input.size,
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
        ...(input.payerUserId ? { payerUserId: input.payerUserId } : {}),
      });
    });
  } catch (err) {
    recordFailure('meter_open', input.sandboxId, err, input.workspaceId);
  }
}

export interface MeterCloseInput {
  sandboxId: string;
  reason: EndReason;
  /** When the box actually stopped, if the fleet said. Defaults to now. */
  endedAt?: Date | null;
  /** For the debug bus only. */
  workspaceId?: string | null;
}

/** A box stopped, suspended or went away. Never throws. */
export async function meterBoxClosed(input: MeterCloseInput): Promise<void> {
  try {
    await runWithoutScope(() => closeInterval(input.sandboxId, input.endedAt ?? new Date(), input.reason));
  } catch (err) {
    recordFailure('meter_close', input.sandboxId, err, input.workspaceId);
  }
}
