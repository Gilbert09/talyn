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
    await db.insert(schema.skills).values([
      { id: 'skill-a', workspaceId: 'ws-a', name: 'a-skill', content: 'a' },
      { id: 'skill-b', workspaceId: 'ws-b', name: 'b-skill', content: 'b' },
    ]);
    await db.insert(schema.skillUsage).values([
      { workspaceId: 'ws-a', skillKey: 'platform:skill-a', usageCount: 1 },
      { workspaceId: 'ws-b', skillKey: 'platform:skill-b', usageCount: 1 },
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
    const skills = await testDb.pglite.query<{ id: string }>(`SELECT id FROM skills ORDER BY id`);
    const usage = await testDb.pglite.query<{ skill_key: string }>(
      `SELECT skill_key FROM skill_usage ORDER BY skill_key`
    );

    await testDb.pglite.exec(`RESET ROLE`);

    expect(ws.rows.map((r) => r.id)).toEqual(['ws-a']);
    expect(tasks.rows.map((r) => r.id)).toEqual(['task-a']); // workspace-keyed policy
    expect(users.rows.map((r) => r.id)).toEqual(['owner-a']); // self-policy
    expect(skills.rows.map((r) => r.id)).toEqual(['skill-a']); // 0029 policy
    expect(usage.rows.map((r) => r.skill_key)).toEqual(['platform:skill-a']);
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

  it('the merge-queue tables are queryable AND owner-scoped under the authenticated role', async () => {
    // Regression pin for the 2026-07-16 incident: 0031 shipped
    // merge_queue_entries/events RLS-enabled with no policies/grants, so the
    // enqueue route's first touch raised `permission denied` and aborted the
    // whole owner-scope request transaction (25P02 cascade — the desktop's
    // "Failed query: select … from pull_requests" error). 0033 added the
    // grants + policies; this proves every route-context operation works as
    // `authenticated` and stays scoped to the claim owner.
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;
    await seedTwoOwners(testDb.db);
    await testDb.db.insert(schema.repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'a/a', url: 'https://github.com/a/a', defaultBranch: 'main' },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'b/b', url: 'https://github.com/b/b', defaultBranch: 'main' },
    ]);
    await testDb.db.insert(schema.pullRequests).values([
      { id: 'pr-a', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'a', repo: 'a', number: 1, state: 'open', lastPolledAt: new Date(), lastSummary: {} },
      { id: 'pr-a2', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'a', repo: 'a', number: 2, state: 'open', lastPolledAt: new Date(), lastSummary: {} },
      { id: 'pr-b', workspaceId: 'ws-b', repositoryId: 'repo-b', owner: 'b', repo: 'b', number: 1, state: 'open', lastPolledAt: new Date(), lastSummary: {} },
    ]);
    await testDb.db.insert(schema.mergeQueueEntries).values([
      { id: 'mqe-a', pullRequestId: 'pr-a', workspaceId: 'ws-a', repositoryId: 'repo-a', baseBranch: 'main' },
      { id: 'mqe-b', pullRequestId: 'pr-b', workspaceId: 'ws-b', repositoryId: 'repo-b', baseBranch: 'main' },
    ]);
    await testDb.db.insert(schema.mergeQueueEvents).values([
      { entryId: 'mqe-a', toStatus: 'queued', trigger: 'test', message: 'a' },
      { entryId: 'mqe-b', toStatus: 'queued', trigger: 'test', message: 'b' },
    ]);

    await testDb.pglite.exec(`SELECT set_config('request.jwt.claim.sub', 'owner-a', false)`);
    await testDb.pglite.exec(`SET ROLE authenticated`);

    // The dual-write INSERT works for the owner's own workspace (incl. the
    // events sequence nextval, which needs its own GRANT)…
    await testDb.pglite.query(
      `INSERT INTO merge_queue_entries (id, pull_request_id, workspace_id, repository_id, base_branch)
       VALUES ('mqe-a2', 'pr-a2', 'ws-a', 'repo-a', 'main')`
    );
    await testDb.pglite.query(
      `INSERT INTO merge_queue_events (entry_id, to_status, trigger, message)
       VALUES ('mqe-a2', 'queued', 'test', 'a2')`
    );
    // SELECTs work (the incident was `permission denied` here) and are scoped
    // to the claim owner — owner-b's rows are invisible.
    const entries = await testDb.pglite.query<{ id: string }>(
      `SELECT id FROM merge_queue_entries ORDER BY id`
    );
    const events = await testDb.pglite.query<{ message: string }>(
      `SELECT message FROM merge_queue_events ORDER BY message`
    );
    // …and is refused for someone else's workspace (WITH CHECK).
    let blocked = false;
    try {
      const res = await testDb.pglite.query(
        `INSERT INTO merge_queue_entries (id, pull_request_id, workspace_id, repository_id, base_branch)
         VALUES ('mqe-x', 'pr-b', 'ws-b', 'repo-b', 'main')`
      );
      blocked = (res.affectedRows ?? 0) === 0;
    } catch {
      blocked = true;
    }
    await testDb.pglite.exec(`RESET ROLE`);

    expect(entries.rows.map((r) => r.id)).toEqual(['mqe-a', 'mqe-a2']);
    expect(events.rows.map((r) => r.message)).toEqual(['a', 'a2']);
    expect(blocked).toBe(true);
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
