import { sql } from 'drizzle-orm';
import {
  getPoolDbClient,
  getScopedDb,
  isRealPostgres,
  runInScopedDb,
  type Database,
} from './client.js';

/**
 * Owner-scoped database access enforces RLS on the privileged backend connection.
 * Each transaction assumes talyn_backend and sets the owner's JWT sub claim.
 * Policies filter on `public.talyn_uid()`, which reads the same two GUCs that
 * `auth.uid()` does. They call ours because no role the backend can create is
 * able to reach schema `auth` on Supabase — see migration 0057.
 * Supabase Data API roles cannot assume this role or access application tables.
 *
 * Real Postgres always enforces RLS here. Tests use pglite without a role switch
 * unless they explicitly test enforcement.
 */

/** Whether owner-scoped transactions are actually being opened. */
export function rlsEnforcementEnabled(): boolean {
  return isRealPostgres();
}

/**
 * Run `fn` with an owner-scoped DB handle. Nested calls reuse the active scope
 * (reentrant), so it's safe to wrap a handler whose services also call it.
 */
export async function withOwnerScope<T>(
  ownerId: string,
  fn: (db: Database) => Promise<T>
): Promise<T> {
  const existing = getScopedDb();
  if (existing) return fn(existing);

  if (!rlsEnforcementEnabled()) {
    // Most pglite tests use the pool without RLS enforcement.
    return fn(getPoolDbClient());
  }

  return getPoolDbClient().transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    // Set both the modern `request.jwt.claims` and the legacy dotted GUC —
    // `public.talyn_uid()` prefers the dotted one and falls back to the JSON,
    // exactly as `auth.uid()` does — then drop to the non-privileged role so
    // RLS applies for the rest of this transaction.
    const claims = JSON.stringify({ sub: ownerId, role: 'talyn_backend' });
    await scoped.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await scoped.execute(sql`select set_config('request.jwt.claim.sub', ${ownerId}, true)`);
    await scoped.execute(sql.raw('set local role talyn_backend'));
    return runInScopedDb(scoped, () => fn(scoped));
  });
}
