import { sql } from 'drizzle-orm';
import {
  getPoolDbClient,
  getScopedDb,
  isRealPostgres,
  runInScopedDb,
  type Database,
} from './client.js';

/**
 * Owner-scoped database access — the runtime half of RLS enforcement.
 *
 * The backend connects to Postgres as a privileged role that bypasses RLS, so
 * the policies in the migrations are inert on their own. `withOwnerScope` makes
 * them bite: it opens a transaction, drops to Supabase's non-privileged
 * `authenticated` role, and injects the caller's id as the JWT `sub` claim that
 * the policies' `auth.uid()` reads. For the life of that transaction every
 * query — including ones inside shared services reached via `getDbClient()` —
 * is filtered to the owner's rows by Postgres itself.
 *
 * Enforcement is always on against real Postgres. The only exception is the
 * test suite's pglite, which runs as a superuser and has no Supabase
 * `authenticated` role to drop into — there `withOwnerScope` runs the callback
 * on the pool, exercising the same query paths without the role switch.
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
    // Flag off or test pglite: preserve current (pool, RLS-bypassing) behaviour.
    return fn(getPoolDbClient());
  }

  return getPoolDbClient().transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    // Set both the modern `request.jwt.claims` (what current Supabase
    // `auth.uid()` reads) and the legacy dotted GUC, then drop to the
    // non-privileged role so RLS applies for the rest of this transaction.
    const claims = JSON.stringify({ sub: ownerId, role: 'authenticated' });
    await scoped.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await scoped.execute(sql`select set_config('request.jwt.claim.sub', ${ownerId}, true)`);
    await scoped.execute(sql.raw('set local role authenticated'));
    return runInScopedDb(scoped, () => fn(scoped));
  });
}
