import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment, Task } from '@talyn/shared';
import { eq } from 'drizzle-orm';
import { FleetClient, type FleetSandbox } from '../services/selfHosted/client.js';
import { selfHostedProvider } from '../services/cloudProviders/selfhosted/provider.js';
import { selfHostedPoller } from '../services/selfHosted/poller.js';
import { dispatchTaskToFleet } from '../services/selfHosted/executor.js';
import { dispatchTaskToPostHogCode } from '../services/posthogCode/executor.js';
import { postHogCodePoller } from '../services/posthogCode/poller.js';
import * as prCache from '../services/prCache.js';
import type { CloudTaskRow } from '../services/cloudProviders/types.js';
import { rowToTask } from '../services/taskSerialize.js';
import { getSelfHostedClient, getSelfHostedCredentials } from '../services/selfHosted/credentials.js';
import { getPostHogCodeClient } from '../services/posthogCode/credentials.js';
import { githubService } from '../services/github.js';
import { reconcileDefaultBranch } from '../services/repoDefaultBranch.js';
import { emitTaskEvent, emitTaskStatus, emitTaskUpdate } from '../services/websocket.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { environments, pullRequests, repositories, tasks, workspaces } from '../db/schema.js';

vi.mock('../services/selfHosted/credentials.js', () => ({
  getSelfHostedClient: vi.fn(),
  getSelfHostedCredentials: vi.fn(),
  resolveFleetTarget: vi.fn(async () => ({ endpoint: 'https://fleet.invalid', token: 'test', host: 'test-host' })),
}));
vi.mock('../services/posthogCode/credentials.js', () => ({
  getPostHogCodeClient: vi.fn(),
  getPostHogCodeCredentials: vi.fn(async () => ({ projectId: 1, host: 'https://posthog.invalid' })),
}));
vi.mock('../services/posthogCode/streamer.js', () => ({ postHogCodeStreamer: {
  ensure: vi.fn(), stop: vi.fn(), isActive: vi.fn(() => false),
} }));
vi.mock('../services/github.js', () => ({ githubService: {
  getAccessToken: vi.fn(() => 'unchecked-token'),
  getVerifiedAccessToken: vi.fn(async () => 'own-github-token'),
} }));
vi.mock('../services/repoDefaultBranch.js', () => ({ reconcileDefaultBranch: vi.fn(async () => 'main') }));
vi.mock('../services/websocket.js', () => ({ emitTaskEvent: vi.fn(), emitTaskStatus: vi.fn(), emitTaskUpdate: vi.fn() }));
vi.mock('../services/analytics.js', () => ({ captureWorkspaceEvent: vi.fn() }));

describe('cloud task tenant isolation', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let ownTask: Task;
  let foreignTask: Task;
  const client = new FleetClient('https://fleet.invalid', 'shared-test-token');
  const posthogClient = { createTask: vi.fn(), startRun: vi.fn(), updateTask: vi.fn(), getTask: vi.fn() };
  const env = { id: 'env1', config: {} } as Environment;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(githubService.getVerifiedAccessToken).mockResolvedValue('own-github-token');
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await seedUser(db, { id: 'other-user' });
    await db.insert(workspaces).values([
      { id: 'ws1', ownerId: TEST_USER_ID, name: 'mine' },
      { id: 'ws2', ownerId: 'other-user', name: 'theirs' },
    ]);
    await db.insert(repositories).values([
      { id: 'repo1', workspaceId: 'ws1', name: 'acme/one', url: 'https://github.com/acme/one' },
      { id: 'repo2', workspaceId: 'ws2', name: 'private/two', url: 'https://github.com/private/two' },
    ]);
    await db.insert(environments).values({ id: env.id, ownerId: TEST_USER_ID, name: 'cloud', type: 'selfhosted', config: {} });
    const rows = await db.insert(tasks).values([
      { id: 'task1', workspaceId: 'ws1', repositoryId: 'repo1', type: 'pr_response', status: 'in_progress', title: 'mine', description: '', metadata: { model: 'claude-sonnet-5' } },
      { id: 'task2', workspaceId: 'ws2', repositoryId: 'repo2', type: 'pr_response', status: 'in_progress', title: 'theirs', description: '' },
    ]).returning();
    ownTask = rowToTask(rows[0]);
    foreignTask = rowToTask(rows[1]);
    vi.mocked(getSelfHostedClient).mockResolvedValue(client);
    vi.mocked(getSelfHostedCredentials).mockResolvedValue({ claudeToken: 'own-claude-token', openaiKey: 'own-openai-token' });
    vi.mocked(getPostHogCodeClient).mockResolvedValue(posthogClient as unknown as Awaited<ReturnType<typeof getPostHogCodeClient>>);
    vi.spyOn(client, 'getSandbox').mockResolvedValue({ sandbox: { id: 'sandbox2', workspaceId: 'ws2', status: 'busy' }, terminal: false });
    vi.spyOn(client, 'getEvents').mockResolvedValue({ events: [], cursor: 0, terminal: false });
    vi.spyOn(client, 'followEvents').mockImplementation(async function* () {});
    vi.spyOn(client, 'setSandboxCredentials').mockResolvedValue(undefined);
    vi.spyOn(client, 'cancelSandbox').mockResolvedValue(undefined);
    vi.spyOn(FleetClient.prototype, 'createSandbox').mockResolvedValue({ sandbox: { id: 'sandbox1', workspaceId: 'ws1', status: 'starting' }, host: 'test-host' });
    posthogClient.createTask.mockResolvedValue({ id: 'posthog1' });
    posthogClient.startRun.mockResolvedValue({ latest_run: { id: 'run1', status: 'queued' } });
  });

  afterEach(async () => {
    selfHostedPoller.stopStreaming('task1');
    selfHostedPoller.stopStreaming('task2');
    await cleanup();
    vi.restoreAllMocks();
  });

  function row(task: Task = ownTask): CloudTaskRow {
    return {
      id: task.id, workspaceId: task.workspaceId, repositoryId: task.repositoryId ?? null,
      title: task.title, status: 'in_progress', completedAt: null, updatedAt: new Date(),
      watched: true, transcriptEmpty: true,
      metadata: { cloudTask: { provider: 'selfhosted', remoteTaskId: 'sandbox2', extra: { llm: 'anthropic', repo: 'acme/one' } } },
    };
  }

  it.each([
    { workspaceId: 'ws2', status: 'busy', adopted: true, adoptedAt: 'adoption1' },
    { workspaceId: 'ws2', status: 'stopped', prUrl: 'https://github.com/private/two/pull/1' },
    { workspaceId: undefined, status: 'busy', adopted: true },
  ])('refuses foreign or unowned sandbox data %j', async (sandbox) => {
    vi.mocked(client.getSandbox).mockResolvedValue({ sandbox: { id: 'sandbox2', ...sandbox } as FleetSandbox, terminal: false });
    const before = await db.select().from(tasks);
    await expect(selfHostedPoller.reconcileTask(row())).rejects.toThrow('Fleet sandbox not found in this workspace');
    expect(client.getEvents).not.toHaveBeenCalled();
    expect(client.followEvents).not.toHaveBeenCalled();
    expect(client.setSandboxCredentials).not.toHaveBeenCalled();
    expect(getSelfHostedCredentials).not.toHaveBeenCalled();
    expect(githubService.getAccessToken).not.toHaveBeenCalled();
    expect(githubService.getVerifiedAccessToken).not.toHaveBeenCalled();
    expect(emitTaskEvent).not.toHaveBeenCalled();
    expect(emitTaskStatus).not.toHaveBeenCalled();
    expect(emitTaskUpdate).not.toHaveBeenCalled();
    expect(await db.select().from(tasks)).toEqual(before);
  });

  it.each(['ws2', undefined])('refuses cancel when sandbox workspace is %s', async (workspaceId) => {
    vi.mocked(client.getSandbox).mockResolvedValue({ sandbox: { id: 'sandbox2', workspaceId, status: 'busy' }, terminal: false });
    await expect(selfHostedProvider.cancel!({ ...ownTask, metadata: row().metadata })).rejects.toThrow('Fleet sandbox not found in this workspace');
    expect(client.cancelSandbox).not.toHaveBeenCalled();
  });

  it('allows each tenant to cancel only its own sandbox with the shared client', async () => {
    await selfHostedProvider.cancel!({ ...foreignTask, metadata: row().metadata });
    expect(client.cancelSandbox).toHaveBeenCalledWith('sandbox2');
    expect(getSelfHostedClient).toHaveBeenCalledWith('ws2');
  });

  it('reads events and restores credentials only after confirming the workspace', async () => {
    vi.mocked(client.getSandbox).mockResolvedValue({ sandbox: { id: 'sandbox2', workspaceId: 'ws1', status: 'busy', adopted: true, adoptedAt: 'adoption1' }, terminal: false });
    await selfHostedPoller.reconcileTask(row());
    expect(client.getEvents).toHaveBeenCalledWith('sandbox2', 0);
    expect(client.followEvents).toHaveBeenCalled();
    expect(client.setSandboxCredentials).toHaveBeenCalledWith('sandbox2', {
      githubToken: 'own-github-token', anthropicKey: 'own-claude-token', repo: 'acme/one',
    });
    expect(getSelfHostedCredentials).toHaveBeenCalledWith('ws1');
    expect(githubService.getVerifiedAccessToken).toHaveBeenCalledWith('ws1');
    expect(githubService.getAccessToken).not.toHaveBeenCalled();
  });

  it('does not restore credentials when the GitHub token is not verified', async () => {
    vi.mocked(client.getSandbox).mockResolvedValue({ sandbox: { id: 'sandbox2', workspaceId: 'ws1', status: 'busy', adopted: true, adoptedAt: 'adoption1' }, terminal: false });
    vi.mocked(githubService.getVerifiedAccessToken).mockResolvedValueOnce(null);
    await selfHostedPoller.reconcileTask(row());
    expect(client.setSandboxCredentials).not.toHaveBeenCalled();
    expect(githubService.getAccessToken).not.toHaveBeenCalled();
    // A refused verification must not suppress a later successful retry.
    await selfHostedPoller.reconcileTask(row());
    expect(client.setSandboxCredentials).toHaveBeenCalledWith('sandbox2', {
      githubToken: 'own-github-token', anthropicKey: 'own-claude-token', repo: 'acme/one',
    });
  });

  it('does not restore credentials when token verification throws', async () => {
    vi.mocked(client.getSandbox).mockResolvedValue({ sandbox: { id: 'sandbox2', workspaceId: 'ws1', status: 'busy', adopted: true }, terminal: false });
    vi.mocked(githubService.getVerifiedAccessToken).mockRejectedValueOnce(new Error('verification failed'));
    await selfHostedPoller.reconcileTask(row());
    expect(client.setSandboxCredentials).not.toHaveBeenCalled();
    expect(githubService.getAccessToken).not.toHaveBeenCalled();
  });

  it('refuses dispatch when only an unchecked GitHub token exists', async () => {
    vi.mocked(githubService.getVerifiedAccessToken).mockResolvedValueOnce(null);
    expect((await dispatchTaskToFleet(ownTask, env)).ok).toBe(false);
    expect(FleetClient.prototype.createSandbox).not.toHaveBeenCalled();
    expect(githubService.getAccessToken).not.toHaveBeenCalled();
  });

  it('does not dispatch when token verification throws', async () => {
    vi.mocked(githubService.getVerifiedAccessToken).mockRejectedValueOnce(new Error('verification failed'));
    await expect(dispatchTaskToFleet(ownTask, env)).rejects.toThrow('verification failed');
    expect(FleetClient.prototype.createSandbox).not.toHaveBeenCalled();
    expect(githubService.getAccessToken).not.toHaveBeenCalled();
  });

  it('sends the verified token for the dispatch workspace', async () => {
    vi.mocked(githubService.getVerifiedAccessToken).mockImplementation(async (workspaceId) =>
      workspaceId === 'ws1' ? 'own-verified-token' : 'other-verified-token',
    );
    expect((await dispatchTaskToFleet(ownTask, env)).ok).toBe(true);
    expect(FleetClient.prototype.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws1', githubToken: 'own-verified-token',
    }));
    expect(githubService.getAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ['fleet', dispatchTaskToFleet], ['posthog', dispatchTaskToPostHogCode],
  ] as const)('%s rejects a foreign repository in background dispatch', async (_name, dispatch) => {
    const before = await db.select().from(tasks);
    const result = await dispatch({ ...ownTask, repositoryId: 'repo2' }, env);
    expect(result.ok).toBe(false);
    expect(FleetClient.prototype.createSandbox).not.toHaveBeenCalled();
    expect(posthogClient.createTask).not.toHaveBeenCalled();
    expect(posthogClient.updateTask).not.toHaveBeenCalled();
    expect(posthogClient.startRun).not.toHaveBeenCalled();
    expect(reconcileDefaultBranch).not.toHaveBeenCalled();
    expect(await db.select().from(tasks)).toEqual(before);
  });

  it.each([
    ['fleet', dispatchTaskToFleet], ['posthog', dispatchTaskToPostHogCode],
  ] as const)('%s still dispatches an owned repository', async (_name, dispatch) => {
    expect((await dispatch(ownTask, env)).ok).toBe(true);
    const [other] = await db.select().from(tasks).where(eq(tasks.id, foreignTask.id));
    expect(other.metadata).toBeNull();
    expect(other.status).toBe('in_progress');
  });

  it.each([
    { workspaceId: 'ws1', repositoryId: 'repo2' },
    { workspaceId: 'ws1', repositoryId: 'missing' },
    { workspaceId: 'ws2', repositoryId: 'repo2' },
    { workspaceId: 'ws1', repositoryId: 'repo1' },
  ].flatMap((reference) => [false, true].map((existing) => ({ ...reference, existing }))))(
    'rejects invalid PR associations before insert or reuse: $workspaceId/$repositoryId existing=$existing',
    async ({ workspaceId, repositoryId, existing }) => {
      // Reproduce a task accepted before repository ownership was checked.
      await db.update(tasks).set({ repositoryId: 'repo2' }).where(eq(tasks.id, ownTask.id));
      if (existing) {
        await db.insert(pullRequests).values({
          id: 'historical-pr', workspaceId: 'ws1', repositoryId: 'repo2',
          owner: 'private', repo: 'two', number: 42, state: 'open',
        });
      }
      const before = await db.select().from(tasks);
      const prsBefore = await db.select().from(pullRequests);
      await expect(prCache.linkTaskToPullRequest({
        workspaceId, repositoryId, taskId: ownTask.id,
        owner: 'private', repo: 'two', number: 42, url: 'https://github.com/private/two/pull/42',
        title: '', author: '', headBranch: '', baseBranch: 'main', headSha: '',
      })).rejects.toThrow('Repository not found for this task and workspace');
      expect(await db.select().from(tasks)).toEqual(before);
      expect(await db.select().from(pullRequests)).toEqual(prsBefore);
    },
  );

  it.each(['repo2', 'missing'])(
    'does not let the PostHog poller associate a historical task with repository %s', async (repositoryId) => {
      const metadata = { posthogTaskId: 'posthog1', posthogRunId: 'run1' };
      await db.update(tasks).set({ repositoryId: 'repo2', metadata }).where(eq(tasks.id, ownTask.id));
      await db.insert(pullRequests).values([
        { id: 'historical-pr', workspaceId: 'ws1', repositoryId: 'repo2', owner: 'private', repo: 'two', number: 42, state: 'open' },
        { id: 'foreign-pr', workspaceId: 'ws2', repositoryId: 'repo2', owner: 'private', repo: 'two', number: 42, state: 'open' },
      ]);
      const prsBefore = await db.select().from(pullRequests);
      const [otherBefore] = await db.select().from(tasks).where(eq(tasks.id, foreignTask.id));
      posthogClient.getTask.mockResolvedValue({
        latest_run: { id: 'run1', status: 'completed', output: { pr_url: 'https://github.com/private/two/pull/42' } },
      });
      const link = vi.spyOn(prCache, 'linkTaskToPullRequest');
      await postHogCodePoller.reconcileTask({ ...row(), repositoryId, metadata, watched: false, transcriptEmpty: false });
      expect(link).not.toHaveBeenCalled();
      expect(await db.select().from(pullRequests)).toEqual(prsBefore);
      const [updated] = await db.select().from(tasks).where(eq(tasks.id, ownTask.id));
      expect(updated.pullRequestId).toBeNull();
      expect(updated.metadata).not.toHaveProperty('pullRequest');
      const [otherAfter] = await db.select().from(tasks).where(eq(tasks.id, foreignTask.id));
      expect(otherAfter).toEqual(otherBefore);
    },
  );

  it('still links an owned PR when the PostHog run completes', async () => {
    posthogClient.getTask.mockResolvedValue({
      latest_run: { id: 'run1', status: 'completed', output: { pr_url: 'https://github.com/acme/one/pull/42' } },
    });
    await postHogCodePoller.reconcileTask({
      ...row(), metadata: { posthogTaskId: 'posthog1', posthogRunId: 'run1' },
      watched: false, transcriptEmpty: false,
    });
    const [pr] = await db.select().from(pullRequests);
    expect(pr).toMatchObject({ workspaceId: 'ws1', repositoryId: 'repo1', taskId: ownTask.id, number: 42 });
    const [updated] = await db.select().from(tasks).where(eq(tasks.id, ownTask.id));
    expect(updated.pullRequestId).toBe(pr.id);
    expect(updated.metadata).toHaveProperty('pullRequest.id', pr.id);
  });
});
