import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import * as schema from '../db/schema.js';
import { rlsEnforcementEnabled, withOwnerScope } from '../db/scope.js';
import { getDbClient } from '../db/client.js';

/**
 * Proves the RLS policies (0002/0013) + the `authenticated` GRANTs (0024)
 * actually filter once the connection drops to the non-privileged
 * `authenticated` role — i.e. that owner-scoping is real, not just declared.
 *
 * pglite runs as a superuser, which bypasses RLS, so we mirror what
 * `withOwnerScope` does at runtime: set the JWT `sub` claim and `SET ROLE
 * authenticated` before querying. The role is reset between cases.
 */
describe('RLS enforcement (authenticated role)', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  async function seedTwoOwners(db: Awaited<ReturnType<typeof createTestDb>>['db']) {
    await seedUser(db, { id: 'owner-a', email: 'a@example.test' });
    await seedUser(db, { id: 'owner-b', email: 'b@example.test' });
    await db.insert(schema.workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await db.insert(schema.tasks).values([
      { id: 'task-a', workspaceId: 'ws-a', type: 'code_writing', title: 'A', description: 'a' },
      { id: 'task-b', workspaceId: 'ws-b', type: 'code_writing', title: 'B', description: 'b' },
    ]);
  }

  it('scopes SELECTs to the claim owner across owner- and workspace-keyed tables', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;
    await seedTwoOwners(testDb.db);

    // Become owner-a under RLS.
    await testDb.pglite.exec(`SELECT set_config('request.jwt.claim.sub', 'owner-a', false)`);
    await testDb.pglite.exec(`SET ROLE authenticated`);

    const ws = await testDb.pglite.query<{ id: string }>(`SELECT id FROM workspaces ORDER BY id`);
    const tasks = await testDb.pglite.query<{ id: string }>(`SELECT id FROM tasks ORDER BY id`);
    const users = await testDb.pglite.query<{ id: string }>(`SELECT id FROM users ORDER BY id`);

    await testDb.pglite.exec(`RESET ROLE`);

    expect(ws.rows.map((r) => r.id)).toEqual(['ws-a']);
    expect(tasks.rows.map((r) => r.id)).toEqual(['task-a']); // workspace-keyed policy
    expect(users.rows.map((r) => r.id)).toEqual(['owner-a']); // self-policy
  });

  it('rejects writing a row into another owner workspace (WITH CHECK)', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;
    await seedTwoOwners(testDb.db);

    await testDb.pglite.exec(`SELECT set_config('request.jwt.claim.sub', 'owner-a', false)`);
    await testDb.pglite.exec(`SET ROLE authenticated`);

    // Insert into owner-b's workspace as owner-a → blocked by the policy's
    // WITH CHECK (the row is invisible/forbidden, so 0 rows affected or error).
    let blocked = false;
    try {
      const res = await testDb.pglite.query(
        `INSERT INTO tasks (id, workspace_id, type, title, description)
         VALUES ('task-x', 'ws-b', 'code_writing', 'x', 'x')`
      );
      blocked = (res.affectedRows ?? 0) === 0;
    } catch {
      blocked = true; // RLS violation raises in Postgres
    }
    await testDb.pglite.exec(`RESET ROLE`);
    expect(blocked).toBe(true);

    // And it really wasn't written.
    const check = await testDb.pglite.query<{ id: string }>(`SELECT id FROM tasks WHERE id = 'task-x'`);
    expect(check.rows).toHaveLength(0);
  });

  it('withOwnerScope is a reentrant passthrough on test pglite (enforcement off)', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;
    await seedTwoOwners(testDb.db);

    // pglite is not real Postgres → enforcement disabled, helper just runs fn.
    expect(rlsEnforcementEnabled()).toBe(false);

    const seen = await withOwnerScope('owner-a', async (db) => {
      expect(db).toBe(getDbClient()); // scoped handle == active client
      // Reentrant: a nested call reuses the same handle.
      return withOwnerScope('owner-a', async (inner) => {
        expect(inner).toBe(db);
        const rows = await inner.select({ id: schema.workspaces.id }).from(schema.workspaces);
        return rows.map((r) => r.id).sort();
      });
    });
    // Passthrough sees everything (no role drop) — both workspaces.
    expect(seen).toEqual(['ws-a', 'ws-b']);
  });
});
