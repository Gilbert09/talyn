import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateWorkflow } from '@talyn/shared';
import type { WorkflowInput } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';
import {
  countWorkflows,
  countWorkflowsQuery,
  createWorkflow,
  deleteWorkflow,
  updateWorkflow,
  _resetWorkflowStore,
} from '../services/workflows/store.js';

/**
 * `countWorkflows` backs the sidebar's nav badge, so it is fetched on every
 * client boot whether or not anybody opens the Workflows page.
 *
 * That is the whole reason it is not `listWorkflows(...).filter(...).length`:
 * the list read ships three jsonb columns per rule AND aggregates the entire
 * run history for the per-workflow stats. The tests below pin both halves of
 * the contract — the number it returns, and the fact that getting it stays
 * cheap.
 */

const WORKSPACE = 'ws-count-1';
const OTHER_WORKSPACE = 'ws-count-2';

function input(over: Partial<WorkflowInput> = {}) {
  return validateWorkflow({
    name: 'Label new PRs',
    events: ['pr_opened'],
    actions: [{ type: 'add_labels', labels: ['talyn-seen'] }],
    ...over,
  });
}

describe('countWorkflows', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
      await db.insert(workspacesTable).values({
        id,
        ownerId: TEST_USER_ID,
        name: id,
        settings: {},
      });
    }
    _resetWorkflowStore();
  });

  afterEach(async () => {
    await cleanup();
    _resetWorkflowStore();
  });

  it('is zero for a workspace with no workflows', async () => {
    await expect(countWorkflows(WORKSPACE)).resolves.toEqual({ enabled: 0 });
  });

  it('counts only enabled workflows', async () => {
    await createWorkflow(WORKSPACE, input({ name: 'on-1', enabled: true }));
    await createWorkflow(WORKSPACE, input({ name: 'on-2', enabled: true }));
    await createWorkflow(WORKSPACE, input({ name: 'off-1', enabled: false }));

    // A disabled rule is not automation that is running — counting it would
    // overstate what the app is doing on the user's behalf.
    await expect(countWorkflows(WORKSPACE)).resolves.toEqual({ enabled: 2 });
  });

  it('is zero when every workflow is disabled, rather than the row count', async () => {
    await createWorkflow(WORKSPACE, input({ name: 'off-1', enabled: false }));
    await createWorkflow(WORKSPACE, input({ name: 'off-2', enabled: false }));
    await expect(countWorkflows(WORKSPACE)).resolves.toEqual({ enabled: 0 });
  });

  it('is scoped to one workspace', async () => {
    await createWorkflow(WORKSPACE, input({ name: 'mine', enabled: true }));
    await createWorkflow(OTHER_WORKSPACE, input({ name: 'theirs-1', enabled: true }));
    await createWorkflow(OTHER_WORKSPACE, input({ name: 'theirs-2', enabled: true }));

    await expect(countWorkflows(WORKSPACE)).resolves.toEqual({ enabled: 1 });
    await expect(countWorkflows(OTHER_WORKSPACE)).resolves.toEqual({ enabled: 2 });
  });

  it('follows an enable/disable toggle', async () => {
    const made = await createWorkflow(WORKSPACE, input({ name: 'toggle', enabled: true }));
    await expect(countWorkflows(WORKSPACE)).resolves.toEqual({ enabled: 1 });

    await updateWorkflow(made.id, WORKSPACE, input({ name: 'toggle', enabled: false }));
    await expect(countWorkflows(WORKSPACE)).resolves.toEqual({ enabled: 0 });

    await updateWorkflow(made.id, WORKSPACE, input({ name: 'toggle', enabled: true }));
    await expect(countWorkflows(WORKSPACE)).resolves.toEqual({ enabled: 1 });
  });

  it('follows a delete', async () => {
    const made = await createWorkflow(WORKSPACE, input({ name: 'doomed', enabled: true }));
    await expect(countWorkflows(WORKSPACE)).resolves.toEqual({ enabled: 1 });

    await deleteWorkflow(made.id, WORKSPACE);
    await expect(countWorkflows(WORKSPACE)).resolves.toEqual({ enabled: 0 });
  });

  it('counts in the database — no definition column ever ships', () => {
    // The egress guard, in the `projectionEgress.test.ts` style. This read runs
    // on every client boot; the moment it selects the definition columns it has
    // become the expensive read it exists to avoid.
    const { sql } = countWorkflowsQuery(WORKSPACE).toSQL();

    expect(sql).toMatch(/count\(\*\)/i);
    for (const column of ['"events"', '"conditions"', '"actions"', '"name"']) {
      expect(sql, `count query selects ${column}: ${sql}`).not.toContain(column);
    }
    // And it never touches the run history, which is what makes the per-workflow
    // stats on `listWorkflows` expensive in the first place.
    expect(sql).not.toContain('workflow_runs');
  });
});
