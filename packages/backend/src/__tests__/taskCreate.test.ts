import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCloudTask } from '../services/taskCreate.js';
import { getSkillUsage } from '../services/skills.js';
import * as skillsModule from '../services/skills.js';
import * as prCacheModule from '../services/prCache.js';
import * as websocketModule from '../services/websocket.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
} from '../db/schema.js';

describe('createCloudTask', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      defaultBranch: 'main',
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function seedPr(over: { id?: string; workspaceId?: string } = {}): Promise<string> {
    const id = over.id ?? 'pr1';
    const workspaceId = over.workspaceId ?? 'ws1';
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId,
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      state: 'open',
      lastSummary: { url: 'https://github.com/acme/widgets/pull/42' },
    });
    return id;
  }

  it('inserts a queued task with defaults and returns the row', async () => {
    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'code_writing',
      title: 'Do the thing',
      description: 'desc',
      repositoryId: 'repo1',
    });

    expect(row.status).toBe('queued');
    expect(row.priority).toBe('medium');
    expect(row.repositoryId).toBe('repo1');
    expect(row.prompt).toBeNull();
    expect(row.metadata).toBeNull();

    const persisted = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, row.id))
      .limit(1);
    expect(persisted[0]?.status).toBe('queued');
  });

  it('honours explicit priority, prompt and environment', async () => {
    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      prompt: 'fix it',
      priority: 'urgent',
      repositoryId: 'repo1',
      assignedEnvironmentId: null,
    });

    expect(row.priority).toBe('urgent');
    expect(row.prompt).toBe('fix it');
    expect(row.assignedEnvironmentId).toBeNull();
  });

  it('stashes runtimeAdapter + model overrides on metadata for dispatch', async () => {
    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'code_writing',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      runtimeAdapter: 'codex',
      model: 'gpt-5',
    });

    expect(row.metadata).toEqual({ runtimeAdapter: 'codex', model: 'gpt-5' });
  });

  it('stashes a pullRequest pointer on metadata and reverse-links the PR row', async () => {
    const prId = await seedPr();

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      pullRequestId: prId,
    });

    const meta = row.metadata as { pullRequest?: { id: string; number: number; url: string } };
    expect(meta.pullRequest?.id).toBe(prId);
    expect(meta.pullRequest?.number).toBe(42);
    expect(meta.pullRequest?.url).toBe('https://github.com/acme/widgets/pull/42');

    const prRows = await db
      .select({ taskId: pullRequestsTable.taskId })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, prId))
      .limit(1);
    expect(prRows[0]?.taskId).toBe(row.id);
  });

  it('skips the PR pointer when the PR belongs to a different workspace', async () => {
    await seedUser(db, { id: 'user-other' });
    await db.insert(workspacesTable).values({
      id: 'ws2',
      ownerId: 'user-other',
      name: 'other',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1', // FK requirement only; the PR row carries its own workspaceId
      workspaceId: 'ws1',
      name: 'x',
      url: 'x',
      defaultBranch: 'main',
    }).onConflictDoNothing();
    const prId = await seedPr({ id: 'pr-foreign', workspaceId: 'ws2' });

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      pullRequestId: prId,
    });

    expect(row.metadata).toBeNull();
    const prRows = await db
      .select({ taskId: pullRequestsTable.taskId })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, prId))
      .limit(1);
    expect(prRows[0]?.taskId).toBeNull();
  });

  it('still creates the task when the PR link fails', async () => {
    const prId = await seedPr();
    vi.spyOn(prCacheModule, 'attachTaskToPullRequestRow').mockRejectedValue(
      new Error('boom')
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      pullRequestId: prId,
    });

    expect(row.status).toBe('queued');
    expect(errSpy).toHaveBeenCalled();
  });

  it('persists metadata.skill and bumps the workspace skill-usage counter', async () => {
    const skill = {
      key: 'repo:acme/widgets:reviewer',
      name: 'reviewer',
      source: 'repo' as const,
      repositoryId: 'repo1',
    };

    const first = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      skill,
    });
    expect((first.metadata as { skill?: unknown }).skill).toEqual(skill);

    await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't2',
      description: '',
      repositoryId: 'repo1',
      skill,
    });

    // The bump is fire-and-forget; give the microtask a beat to land.
    await vi.waitFor(async () => {
      const usage = await getSkillUsage('ws1');
      expect(usage[skill.key]?.count).toBe(2);
    });
  });

  it('creates the task even when the usage bump fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(skillsModule, 'bumpSkillUsage').mockRejectedValue(new Error('db down'));

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      skill: { key: 'local:x', name: 'x', source: 'local' },
    });
    expect(row.status).toBe('queued');
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
  });

  it('announces the new task over the workspace WS room', async () => {
    const spy = vi.spyOn(websocketModule, 'emitTaskCreated');

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'code_writing',
      title: 'announce me',
      description: '',
      repositoryId: 'repo1',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [workspaceId, task] = spy.mock.calls[0];
    expect(workspaceId).toBe('ws1');
    expect(task.id).toBe(row.id);
    expect(task.title).toBe('announce me');
  });
});
