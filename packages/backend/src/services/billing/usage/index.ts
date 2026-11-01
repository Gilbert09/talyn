/**
 * Usage ledger: the public API that gates (WP3/WP5) and metering hooks (WP4)
 * code against. Money is integer micro-dollars; usage is integer weighted
 * seconds (see `packages/shared/src/pricing.ts`).
 */
import type { Micros, PlanTier, SandboxSize, UsagePeriod, UsageSubjectKind } from '@talyn/shared';

export type { UsageSubjectKind } from '@talyn/shared';

/** Why an interval closed. */
export type EndReason = 'terminal' | 'suspended' | 'deleted' | 'vanished' | 'exhausted' | 'sweep';

export interface OpenIntervalInput {
  ownerId: string;
  workspaceId?: string | null;
  subjectKind: UsageSubjectKind;
  subjectId: string;
  sandboxId: string;
  size: SandboxSize;
  /** Defaults to now. */
  startedAt?: Date;
}

export interface UsageBudget {
  tier: PlanTier;
  period: UsagePeriod;
  includedWsec: number;
  usedWsec: number;
  /** Included weighted seconds left this period, 0 or more. */
  includedLeftWsec: number;
  /** Live (unexpired) credit balance. */
  creditMicros: Micros;
  /** Included hours and credits are spent, and no auto top-up succeeded. */
  exhausted: boolean;
  /** Auto top-up is on and has room this month, so a shortfall can still be covered. */
  autoTopupPossible: boolean;
}

/**
 * Start metering a box. Idempotent per sandbox: a second open while one is
 * open is a no-op.
 */
export async function openInterval(_input: OpenIntervalInput): Promise<void> {
  throw new Error('not implemented');
}

/**
 * Stop metering a box at `endedAt`, then charge its owner. A close with no
 * open interval is a no-op.
 */
export async function closeInterval(_sandboxId: string, _endedAt: Date, _reason: EndReason): Promise<void> {
  throw new Error('not implemented');
}

/** Boxes of the owner with an open interval. */
export async function countOpenBoxes(_ownerId: string): Promise<number> {
  throw new Error('not implemented');
}

/** The owner's budget for the current period, after charging what is owed. */
export async function getBudget(_ownerId: string): Promise<UsageBudget> {
  throw new Error('not implemented');
}

/** Charge the owner's open intervals up to now. Idempotent and safe across replicas. */
export async function chargeOwner(_ownerId: string): Promise<void> {
  throw new Error('not implemented');
}
