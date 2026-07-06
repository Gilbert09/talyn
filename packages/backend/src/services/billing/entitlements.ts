import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  getDbClient,
  getPoolDbClient,
  getScopedDb,
  isRealPostgres,
} from '../../db/client.js';
import { tasks as tasksTable, users as usersTable, workspaces as workspacesTable } from '../../db/schema.js';
import { advisoryLockKey, withBlockingAdvisoryLock } from '../advisoryLock.js';

/**
 * Plan entitlements — the provider-agnostic seam every limit check goes
 * through. Nothing in here knows about Polar beyond "webhooks maintain
 * `users.plan`"; the Polar client/webhook adapter lives alongside in
 * services/billing/ and can be swapped without touching enforcement.
 *
 * Free plan: at most FREE_ACTIVE_TASK_LIMIT tasks in an active status at
 * once, counted across every workspace the user owns. Paid/comped: no limit.
 */

export const FREE_ACTIVE_TASK_LIMIT = 3;

/** Statuses that occupy a free-plan slot (mirrors the desktop's ACTIVE_TASK_STATUSES). */
export const ACTIVE_TASK_STATUSES = ['pending', 'queued', 'in_progress'] as const;

export type EffectivePlan = 'free' | 'unlimited';

export interface Entitlement {
  plan: EffectivePlan;
  source: 'default' | 'subscription' | 'override' | 'billing_disabled';
}

/** Thrown by the gate when a free owner is at their active-task limit. */
export class TaskLimitError extends Error {
  readonly code = 'task_limit_reached';
  constructor(
    readonly limit: number,
    readonly active: number
  ) {
    super(
      `Free plan is limited to ${limit} active tasks (${active} in use). ` +
        `Upgrade for unlimited tasks, or wait for a task to finish.`
    );
    this.name = 'TaskLimitError';
  }
}

/**
 * Whether billing is configured at all. When the Polar env group is absent
 * (local dev, CI, self-hosted) task limits are NOT enforced — a paywall with
 * no way to pay would brick task creation at 3 with zero recourse. Partial
 * config is a boot error (validateEnv), so checking one var here is enough;
 * this also doubles as a production kill switch.
 */
export function billingEnabled(): boolean {
  return Boolean(process.env.POLAR_ACCESS_TOKEN);
}

/**
 * Resolve the effective plan for an owner: manual override first (the comp
 * flag — set via SQL, never by webhooks), then the webhook-driven plan.
 */
export async function resolveEntitlement(ownerId: string): Promise<Entitlement> {
  if (!billingEnabled()) return { plan: 'unlimited', source: 'billing_disabled' };

  const rows = await getDbClient()
    .select({ plan: usersTable.plan, planOverride: usersTable.planOverride })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  const row = rows[0];
  if (!row) return { plan: 'free', source: 'default' };

  if (row.planOverride === 'unlimited' || row.planOverride === 'free') {
    return { plan: row.planOverride, source: 'override' };
  }
  if (row.plan === 'unlimited') return { plan: 'unlimited', source: 'subscription' };
  return { plan: 'free', source: 'default' };
}

/**
 * The count query, exported unexecuted so the egress test can `.toSQL()` it:
 * a pure count over tasks joined to the owner's workspaces — must never ship
 * task columns (transcript!) to the backend.
 */
export function countActiveTasksQuery(ownerId: string, excludeTaskId?: string) {
  const conditions = [
    eq(workspacesTable.ownerId, ownerId),
    inArray(tasksTable.status, [...ACTIVE_TASK_STATUSES]),
  ];
  if (excludeTaskId) conditions.push(ne(tasksTable.id, excludeTaskId));
  return getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(tasksTable)
    .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
    .where(and(...conditions));
}

/** How many active tasks the owner has right now, across all their workspaces. */
export async function countActiveTasks(
  ownerId: string,
  excludeTaskId?: string
): Promise<number> {
  const rows = await countActiveTasksQuery(ownerId, excludeTaskId);
  return rows[0]?.count ?? 0;
}

interface GateOptions {
  /**
   * A task being re-activated (retry/start/PATCH) rather than created —
   * excluded from the count so an idempotent re-queue of a still-active task
   * can never self-block.
   */
  excludeTaskId?: string;
}

/**
 * Run `fn` (which creates or re-activates one task) unless the owner is a
 * free user already at the limit, in which case throw TaskLimitError.
 *
 * Race safety: two concurrent creations at 2/3 must not both pass, so the
 * free-plan path serializes per owner on a transaction-scoped advisory lock
 * (the only advisory flavour safe through Supabase's transaction-mode
 * pooler — see services/advisoryLock.ts):
 *
 * - Inside an ownerScope request transaction (routes), the lock is taken on
 *   that transaction and held until the task insert COMMITS — a concurrent
 *   request blocks on the lock and then counts the committed row.
 * - On the unscoped pool (watchers), withBlockingAdvisoryLock holds a pure
 *   mutex transaction open while `fn`'s pool statements auto-commit, so the
 *   insert is durable before the mutex releases.
 * - On pglite (tests) the lock is skipped — the single-connection harness
 *   would self-deadlock, and cross-connection races don't exist there.
 *
 * Unlimited/comped owners skip both the lock and the count entirely.
 */
export async function withTaskLimitGate<T>(
  ownerId: string,
  options: GateOptions,
  fn: () => Promise<T>
): Promise<T> {
  const entitlement = await resolveEntitlement(ownerId);
  if (entitlement.plan !== 'free') return fn();

  const assertWithinLimit = async () => {
    const active = await countActiveTasks(ownerId, options.excludeTaskId);
    if (active >= FREE_ACTIVE_TASK_LIMIT) {
      throw new TaskLimitError(FREE_ACTIVE_TASK_LIMIT, active);
    }
  };

  if (!isRealPostgres()) {
    await assertWithinLimit();
    return fn();
  }

  const lockName = `taskLimit:${ownerId}`;
  const scoped = getScopedDb();
  if (scoped) {
    // Route path: piggyback on the request's ownerScope transaction so the
    // lock outlives the check AND the insert, releasing only at commit.
    const key = advisoryLockKey(lockName).toString();
    await scoped.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
    await assertWithinLimit();
    return fn();
  }

  // Watcher path: dedicated mutex transaction on the pool.
  return withBlockingAdvisoryLock(getPoolDbClient(), lockName, async () => {
    await assertWithinLimit();
    return fn();
  });
}

/**
 * Gate for re-activating an existing task (retry / start / PATCH to an
 * active status). Counts everything except the task itself.
 */
export async function assertCanActivateTask(ownerId: string, taskId: string): Promise<void> {
  await withTaskLimitGate(ownerId, { excludeTaskId: taskId }, async () => undefined);
}
