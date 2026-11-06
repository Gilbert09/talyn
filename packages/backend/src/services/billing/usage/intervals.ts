import { randomUUID } from 'crypto';
import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { SIZE_WEIGHT, type SandboxSize, type UsageSubjectKind } from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import { usageIntervals } from '../../../db/schema.js';

/** Why an interval closed. */
export type EndReason = 'terminal' | 'suspended' | 'deleted' | 'vanished' | 'exhausted' | 'sweep' | 'payer_change';

export interface OpenIntervalInput {
  ownerId: string;
  workspaceId?: string | null;
  subjectKind: UsageSubjectKind;
  subjectId: string;
  sandboxId: string;
  size: SandboxSize;
  /** Defaults to now. */
  startedAt?: Date;
  /** A teammate who pays for this box (Teams and Spaces). `ownerId` is then that teammate. */
  payerUserId?: string | null;
}

/** What the charge step reads. No column here is large. */
export const INTERVAL_COLUMNS = {
  id: usageIntervals.id,
  ownerId: usageIntervals.ownerId,
  workspaceId: usageIntervals.workspaceId,
  subjectKind: usageIntervals.subjectKind,
  subjectId: usageIntervals.subjectId,
  sandboxId: usageIntervals.sandboxId,
  size: usageIntervals.size,
  startedAt: usageIntervals.startedAt,
  endedAt: usageIntervals.endedAt,
  billedThrough: usageIntervals.billedThrough,
  payerUserId: usageIntervals.payerUserId,
} as const;

export type IntervalRow = Pick<typeof usageIntervals.$inferSelect, keyof typeof INTERVAL_COLUMNS>;

const db = () => getPoolDbClient();

/** Whether a new open interval was inserted (false when one was already open). */
export async function insertOpenInterval(input: OpenIntervalInput): Promise<boolean> {
  const startedAt = input.startedAt ?? new Date();
  const rows = await db()
    .insert(usageIntervals)
    .values({
      id: randomUUID(),
      ownerId: input.ownerId,
      workspaceId: input.workspaceId ?? null,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      sandboxId: input.sandboxId,
      size: input.size,
      weight: SIZE_WEIGHT[input.size].toFixed(2),
      startedAt,
      billedThrough: startedAt,
      payerUserId: input.payerUserId ?? null,
    })
    .onConflictDoNothing({ target: usageIntervals.sandboxId, where: sql`${usageIntervals.endedAt} IS NULL` })
    .returning({ id: usageIntervals.id });
  return rows.length > 0;
}

/**
 * Close the box's open interval at `endedAt`. Returns the owner when a row
 * closed, null when none was open.
 *
 * The end never falls before what the meter already billed (the CAS cursor),
 * so a late close (a sweep that saw a suspend after a charge) cannot leave an
 * interval billed past its own end. The bound is passed as an ISO string: a
 * Date in a raw `sql` fragment reaches postgres-js unencoded and throws.
 */
export async function markIntervalClosed(sandboxId: string, endedAt: Date, reason: EndReason): Promise<{ ownerId: string } | null> {
  const rows = await db()
    .update(usageIntervals)
    .set({
      endedAt: sql`GREATEST(${endedAt.toISOString()}::timestamptz, ${usageIntervals.billedThrough})`,
      endReason: reason,
    })
    .where(and(eq(usageIntervals.sandboxId, sandboxId), isNull(usageIntervals.endedAt)))
    .returning({ ownerId: usageIntervals.ownerId });
  return rows[0] ?? null;
}

export function countOpenBoxesQuery(ownerId: string) {
  return db()
    .select({ n: count() })
    .from(usageIntervals)
    .where(and(eq(usageIntervals.ownerId, ownerId), isNull(usageIntervals.endedAt)));
}

export async function countOpen(ownerId: string): Promise<number> {
  const [row] = await countOpenBoxesQuery(ownerId);
  return Number(row?.n ?? 0);
}

/** The owner's intervals the meter still owes: open, or closed and not billed to their end. */
export function unbilledIntervalsQuery(ownerId: string) {
  return db()
    .select(INTERVAL_COLUMNS)
    .from(usageIntervals)
    .where(
      and(
        eq(usageIntervals.ownerId, ownerId),
        or(isNull(usageIntervals.endedAt), lt(usageIntervals.billedThrough, usageIntervals.endedAt)),
      ),
    );
}

/** Owners with anything left to bill. Served by the partial unbilled index. */
export function ownersWithUnbilledQuery() {
  return db()
    .selectDistinct({ ownerId: usageIntervals.ownerId })
    .from(usageIntervals)
    .where(or(isNull(usageIntervals.endedAt), lt(usageIntervals.billedThrough, usageIntervals.endedAt)));
}

/** Every open interval (the sweep compares them with the fleet). */
export function openIntervalsQuery() {
  return db().select(INTERVAL_COLUMNS).from(usageIntervals).where(isNull(usageIntervals.endedAt));
}

/** The owner's open intervals of one kind (exhaustion reads the workbench ones). */
export function openIntervalsOfKindQuery(ownerId: string, kind: UsageSubjectKind) {
  return db()
    .select(INTERVAL_COLUMNS)
    .from(usageIntervals)
    .where(and(eq(usageIntervals.ownerId, ownerId), eq(usageIntervals.subjectKind, kind), isNull(usageIntervals.endedAt)));
}

/** The open interval of one subject, if any. */
export function openIntervalOfSubjectQuery(kind: UsageSubjectKind, subjectId: string) {
  return db()
    .select(INTERVAL_COLUMNS)
    .from(usageIntervals)
    .where(and(eq(usageIntervals.subjectKind, kind), eq(usageIntervals.subjectId, subjectId), isNull(usageIntervals.endedAt)))
    .limit(1);
}

/**
 * Move the CAS cursor from `prev` to `next` and add `deltaWsec`. True when
 * this caller won; false when another charge moved the cursor first.
 */
export async function advanceBilledThrough(id: string, prev: Date, next: Date, deltaWsec: number): Promise<boolean> {
  const rows = await db()
    .update(usageIntervals)
    .set({ billedThrough: next, billedWsec: sql`${usageIntervals.billedWsec} + ${deltaWsec}` })
    .where(and(eq(usageIntervals.id, id), eq(usageIntervals.billedThrough, prev)))
    .returning({ id: usageIntervals.id });
  return rows.length > 0;
}
