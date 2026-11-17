import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { loops, repositories, workflows, workspaces } from '../db/schema.js';

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/0144_automations_start_sessions.sql'
);

/**
 * Migration 0144: no automation creates a cloud task. Old loops start sessions,
 * and old rule actions that started a task are rewritten as `start_session`.
 * The fixture holds the old rows; the test runs the migration on them again.
 */
describe('migration 0144: automations start sessions', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  async function runMigrationAgain() {
    const statements = fs
      .readFileSync(MIGRATION, 'utf-8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) await testDb.pglite.exec(stmt);
  }

  const loop = (id: string, values: Partial<typeof loops.$inferInsert>) => ({
    id,
    workspaceId: 'ws1',
    name: id,
    enabled: true,
    prompt: 'Do the thing',
    cron: '0 9 * * *',
    timezone: 'UTC',
    provider: 'selfhosted',
    model: 'claude-sonnet-5-5',
    target: 'task',
    repositoryId: 'repo1',
    repoFullName: 'acme/one',
    nextRunAt: new Date(Date.now() + 3_600_000),
    ...values,
  });

  const rule = (id: string, actions: unknown[], integration = 'github') => ({
    id,
    workspaceId: 'ws1',
    integration,
    name: id,
    events: ['pr_opened'],
    actions,
  });

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine' });
    await testDb.db
      .insert(repositories)
      .values({ id: 'repo1', workspaceId: 'ws1', name: 'acme/one', url: 'https://github.com/acme/one' });
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it('moves every loop to sessions, clears its MCP pick, and turns off PostHog Code loops', async () => {
    await testDb.db.insert(loops).values([
      loop('fleet-task', { mcpServerIds: ['mcp-1'] }),
      loop('fleet-session', { target: 'session' }),
      loop('phc-on', { provider: 'posthog_code', model: 'claude-opus-5' }),
      loop('phc-off', { provider: 'posthog_code', model: 'claude-opus-5', enabled: false, nextRunAt: null }),
    ]);

    await runMigrationAgain();

    const rows = await testDb.db
      .select({
        id: loops.id,
        target: loops.target,
        enabled: loops.enabled,
        mcpServerIds: loops.mcpServerIds,
        disabledReason: loops.disabledReason,
        nextRunAt: loops.nextRunAt,
      })
      .from(loops)
      .orderBy(asc(loops.id));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    for (const r of rows) {
      expect(r.target, r.id).toBe('session');
      expect(r.mcpServerIds, r.id).toBeNull();
    }
    expect(byId['fleet-task']).toMatchObject({ enabled: true, disabledReason: null });
    expect(byId['fleet-task'].nextRunAt).not.toBeNull();
    expect(byId['fleet-session']).toMatchObject({ enabled: true, disabledReason: null });
    expect(byId['phc-on']).toMatchObject({ enabled: false, disabledReason: 'environment_missing', nextRunAt: null });
    // A loop the person had already turned off keeps its own state.
    expect(byId['phc-off']).toMatchObject({ enabled: false, disabledReason: null });
  });

  it('gives a new loop row the session target by default', async () => {
    await runMigrationAgain();
    await testDb.pglite.exec(
      `INSERT INTO loops (id, workspace_id, name, prompt, cron, timezone, provider, model, repo_full_name)
       VALUES ('raw', 'ws1', 'raw', 'x', '0 9 * * *', 'UTC', 'selfhosted', 'claude-sonnet-5-5', 'acme/one')`
    );
    const [row] = await testDb.db.select({ target: loops.target }).from(loops).where(eq(loops.id, 'raw'));
    expect(row.target).toBe('session');
  });

  it.each([
    [
      'run_prompt on a GitHub rule',
      'github',
      [{ type: 'run_prompt', prompt: 'Review this', model: 'claude-sonnet-5-5' }],
      [{ type: 'start_session', prompt: 'Review this', model: 'claude-sonnet-5-5', repositoryId: null }],
    ],
    [
      'start_task on a webhook rule',
      'webhook',
      [{ type: 'start_task', repositoryId: 'repo1', prompt: 'Fix it', internetAccess: true }],
      [{ type: 'start_session', repositoryId: 'repo1', prompt: 'Fix it', internetAccess: true }],
    ],
    [
      'start_task on an issue rule, with the other actions in order',
      'github_issues',
      [
        { type: 'start_task', repositoryId: null, prompt: 'Fix it', issueStartComment: false },
        { type: 'issue_set_status', status: 'open' },
      ],
      [
        { type: 'start_session', repositoryId: null, prompt: 'Fix it', issueStartComment: false },
        { type: 'issue_set_status', status: 'open' },
      ],
    ],
    [
      'a mix, in order',
      'github',
      [
        { type: 'add_labels', labels: ['x'] },
        { type: 'run_prompt', prompt: 'A' },
        { type: 'run_skill', skillKey: 'platform:s1' },
      ],
      [
        { type: 'add_labels', labels: ['x'] },
        { type: 'start_session', prompt: 'A', repositoryId: null },
        { type: 'run_skill', skillKey: 'platform:s1' },
      ],
    ],
  ])('rewrites %s as start_session', async (_name, integration, before, after) => {
    await testDb.db.insert(workflows).values(rule('r1', before, integration));

    await runMigrationAgain();

    const [row] = await testDb.db.select({ actions: workflows.actions }).from(workflows).where(eq(workflows.id, 'r1'));
    expect(row.actions).toEqual(after);
  });

  it('leaves a rule with no task action untouched', async () => {
    const actions = [{ type: 'add_labels', labels: ['x'] }, { type: 'start_session', repositoryId: null, prompt: 'p' }];
    await testDb.db.insert(workflows).values(rule('r2', actions));
    const [before] = await testDb.db.select({ updatedAt: workflows.updatedAt }).from(workflows).where(eq(workflows.id, 'r2'));

    await runMigrationAgain();

    const [row] = await testDb.db
      .select({ actions: workflows.actions, updatedAt: workflows.updatedAt })
      .from(workflows)
      .where(eq(workflows.id, 'r2'));
    expect(row.actions).toEqual(actions);
    expect(row.updatedAt).toEqual(before.updatedAt);
  });
});
