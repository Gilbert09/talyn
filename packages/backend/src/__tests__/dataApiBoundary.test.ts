import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import * as schema from '../db/schema.js';

describe('Data API database boundary', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  afterEach(async () => {
    await testDb?.cleanup();
  });

  it.each(['anon', 'authenticated', 'authenticator', 'public_probe'])(
    '%s cannot read or write any application table or sequence', async (role) => {
      testDb = await createTestDb();
      await seedUser(testDb.db, { id: 'owner-a' });
      await testDb.db.insert(schema.workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
      await testDb.db.insert(schema.tasks).values({
        id: 'task-a', workspaceId: 'ws-a', type: 'code_writing', title: 'A', description: '',
      });
      await testDb.pglite.exec(`
        CREATE ROLE public_probe NOLOGIN;
        CREATE TABLE public.future_table_probe (id serial PRIMARY KEY);
      `);
      const tables = await testDb.pglite.query<{ name: string; column: string }>(`
        SELECT c.relname AS name, a.attname AS column
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = 1
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      `);
      const sequences = await testDb.pglite.query<{ name: string }>(`
        SELECT sequencename AS name FROM pg_sequences WHERE schemaname = 'public'
      `);
      await testDb.pglite.exec(`SELECT set_config('request.jwt.claim.sub', 'owner-a', false)`);
      await testDb.pglite.exec(`SET ROLE ${role}`);

      // This also guards future explicit grants, not only default privileges.
      for (const { name, column } of tables.rows) {
        for (const query of [
          `SELECT * FROM public."${name}"`,
          `INSERT INTO public."${name}" DEFAULT VALUES`,
          `UPDATE public."${name}" SET "${column}" = "${column}"`,
          `DELETE FROM public."${name}"`,
          `TRUNCATE public."${name}"`,
        ]) {
          await expect(testDb.pglite.query(query), query).rejects.toMatchObject({
            code: '42501', message: expect.stringContaining('permission denied'),
          });
        }
      }
      for (const { name } of sequences.rows) {
        await expect(testDb.pglite.query(`SELECT nextval('public."${name}"')`)).rejects.toMatchObject({ code: '42501' });
        await expect(testDb.pglite.query(`SELECT * FROM public."${name}"`)).rejects.toMatchObject({ code: '42501' });
      }
      for (const query of [
        `UPDATE tasks SET metadata = '{"cloudTask":{"id":"foreign-run"},"loopId":"foreign-loop"}' WHERE id = 'task-a'`,
        `UPDATE users SET is_admin = true, plan_override = 'unlimited' WHERE id = 'owner-a'`,
        `UPDATE integrations SET config = '{"authMethod":"key","apiKey":"forged"}' WHERE workspace_id = 'ws-a'`,
        `UPDATE loop_runs SET task_id = 'foreign-task', loop_id = 'foreign-loop'`,
        `UPDATE workflow_runs SET task_id = 'foreign-task', workflow_id = 'foreign-workflow'`,
        `UPDATE tasks SET workspace_id = 'foreign-workspace' WHERE id = 'task-a'`,
      ]) {
        await expect(testDb.pglite.query(query), query).rejects.toMatchObject({ code: '42501' });
      }
      // Auth schema access and auth.uid() remain available to JWT roles.
      if (role === 'anon' || role === 'authenticated') {
        expect((await testDb.pglite.query('SELECT auth.uid() AS id')).rows).toEqual([{ id: 'owner-a' }]);
      }
    },
  );

  it('keeps the backend role restricted and unavailable to Data API sessions', async () => {
    testDb = await createTestDb();
    const attributes = await testDb.pglite.query(`
      SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit
      FROM pg_roles WHERE rolname = 'talyn_backend'
    `);
    expect(attributes.rows).toEqual([{
      rolcanlogin: false, rolsuper: false, rolbypassrls: false,
      rolcreaterole: false, rolcreatedb: false, rolinherit: false,
    }]);
    for (const role of ['anon', 'authenticated', 'authenticator']) {
      const membership = await testDb.pglite.query(`SELECT pg_has_role('${role}', 'talyn_backend', 'MEMBER') AS member`);
      expect(membership.rows).toEqual([{ member: false }]);
      // SET ROLE alone retains the superuser session's right to assume any role.
      await testDb.pglite.exec(`SET SESSION AUTHORIZATION ${role}`);
      await expect(testDb.pglite.exec('SET ROLE talyn_backend')).rejects.toMatchObject({ code: '42501' });
      await testDb.pglite.exec('RESET SESSION AUTHORIZATION');
    }
  });

  it('removes independent column grants without changing auth schema privileges', async () => {
    testDb = await createTestDb();
    // Restore a pre-migration role state with additional column-level grants.
    await testDb.pglite.exec(`
      DROP OWNED BY talyn_backend;
      DROP ROLE talyn_backend;
      GRANT SELECT (metadata), UPDATE (metadata), INSERT (metadata) ON tasks TO PUBLIC, anon, authenticated;
      CREATE TABLE auth.login_probe (id serial);
      GRANT ALL ON auth.login_probe TO anon, authenticated;
      GRANT ALL ON SEQUENCE auth.login_probe_id_seq TO anon, authenticated;
    `);
    const migration = fs.readFileSync(path.resolve(__dirname, '../db/migrations/0057_backend_data_boundary.sql'), 'utf8');
    await testDb.pglite.exec(migration);
    for (const role of ['anon', 'authenticated']) {
      await testDb.pglite.exec(`SET ROLE ${role}`);
      for (const query of [
        'SELECT metadata FROM tasks',
        `UPDATE tasks SET metadata = '{}'`,
        `INSERT INTO tasks (metadata) VALUES ('{}')`,
      ]) {
        await expect(testDb.pglite.query(query)).rejects.toMatchObject({ code: '42501' });
      }
      await testDb.pglite.query('SELECT auth.uid()');
      await testDb.pglite.query('INSERT INTO auth.login_probe DEFAULT VALUES');
      await testDb.pglite.query('SELECT * FROM auth.login_probe');
      await testDb.pglite.exec('RESET ROLE');
    }
  });

  it('grants the backend only the approved table privileges', async () => {
    testDb = await createTestDb();
    const grants = await testDb.pglite.query<{ table_name: string; privileges: string[] }>(`
      SELECT table_name, array_agg(privilege_type ORDER BY privilege_type) AS privileges
      FROM information_schema.role_table_grants
      WHERE grantee = 'talyn_backend' AND table_schema = 'public'
      GROUP BY table_name ORDER BY table_name
    `);
    const crud = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
    expect(Object.fromEntries(grants.rows.map((row) => [row.table_name, row.privileges]))).toEqual({
      users: crud, workspaces: crud, environments: crud, repositories: crud,
      integrations: crud, tasks: crud, pull_requests: crud, mcp_tokens: crud,
      skills: crud, skill_usage: crud, merge_queue_entries: crud, workflows: crud, loops: crud,
      // mcp_servers holds an encrypted credential per row, so its grant is the
      // one in here most worth having to add on purpose.
      mcp_servers: crud,
      review_ranking_participants: crud,
      review_ranking_events: crud,
      review_ranking_outcomes: crud,
      merge_queue_events: ['INSERT', 'SELECT'],
      posthog_oauth_states: ['DELETE', 'INSERT', 'SELECT'],
      release_notes: ['SELECT'],
      workflow_runs: ['INSERT', 'SELECT', 'UPDATE'],
      loop_runs: ['INSERT', 'SELECT', 'UPDATE'],
    });
    await testDb.pglite.exec('SET ROLE talyn_backend');
    for (const table of ['settings', 'admin_audit_log', 'billing_events', 'fleet_hosts', 'github_installations']) {
      await expect(testDb.pglite.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(testDb.pglite.query(`INSERT INTO ${table} DEFAULT VALUES`)).rejects.toMatchObject({ code: '42501' });
    }
  });
});
