import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment, Task } from '@talyn/shared';
import { FLEET_MODELS, POSTHOG_CODE_MODELS } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { repositories, workspaces } from '../db/schema.js';
import { dispatchTaskToPostHogCode } from '../services/posthogCode/executor.js';
import { getPostHogCodeClient } from '../services/posthogCode/credentials.js';
import { emitTaskUpdate } from '../services/websocket.js';

/**
 * What PostHog Code runs when a task FAILED OVER to it.
 *
 * The fleet is one box. When it is full the queue moves the task to the next
 * link in the chain, which is this provider — and that is the design working,
 * not a fault. But the task still carries `metadata.model`, and it was chosen
 * for the fleet: six of the fleet's models are ones PostHog's runtime does not
 * accept, because Talyn always sends the `claude` runtime adapter.
 *
 * Sent verbatim they earn a 400 at dispatch, which turns a capacity refusal the
 * fall-back exists to absorb into a failed task. The workspace-setting rung was
 * already guarded; the task rung was not.
 */

vi.mock('../services/posthogCode/credentials.js', () => ({
  getPostHogCodeClient: vi.fn(),
  getPostHogCodeCredentials: vi.fn(async () => ({ projectId: 1, host: 'https://posthog.invalid' })),
}));
vi.mock('../services/posthogCode/streamer.js', () => ({
  postHogCodeStreamer: { ensure: vi.fn(), stop: vi.fn(), isActive: vi.fn(() => false) },
}));
vi.mock('../services/github.js', () => ({
  githubService: {
    getAccessToken: vi.fn(() => 'unchecked-token'),
    getVerifiedAccessToken: vi.fn(async () => 'gh-token'),
  },
}));
vi.mock('../services/repoDefaultBranch.js', () => ({
  reconcileDefaultBranch: vi.fn(async () => 'main'),
}));
vi.mock('../services/websocket.js', () => ({
  emitTaskEvent: vi.fn(),
  emitTaskStatus: vi.fn(),
  emitTaskUpdate: vi.fn(),
}));
vi.mock('../services/analytics.js', () => ({ captureWorkspaceEvent: vi.fn() }));

const POSTHOG_IDS = new Set(POSTHOG_CODE_MODELS.map((m) => m.id));
/** Exactly the models a failover can arrive carrying that this provider cannot run. */
const FLEET_ONLY = FLEET_MODELS.map((m) => m.id).filter((id) => !POSTHOG_IDS.has(id));

describe('a task that failed over from the fleet', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const client = { createTask: vi.fn(), startRun: vi.fn(), updateTask: vi.fn(), getTask: vi.fn() };
  const env = { id: 'env1', config: {} } as Environment;

  function task(metadata: Record<string, unknown>): Task {
    return {
      id: 'task-1',
      workspaceId: 'ws1',
      type: 'pr_response',
      status: 'queued',
      priority: 'medium',
      title: 'Fix it',
      description: 'Fix it',
      prompt: 'Fix it',
      repositoryId: 'repo1',
      metadata,
      createdAt: '',
      updatedAt: '',
    } as Task;
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(repositories).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'acme/widget',
      url: 'https://github.com/acme/widget',
      defaultBranch: 'main',
    });
    client.createTask.mockResolvedValue({ id: 'remote-1' });
    client.startRun.mockResolvedValue({ id: 'run-1' });
    client.updateTask.mockResolvedValue(undefined);
    vi.mocked(getPostHogCodeClient).mockResolvedValue(client as never);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanup();
  });

  /**
   * The model actually sent to PostHog on the run this dispatch started.
   *
   * `startRun(remoteTaskId, { runtimeAdapter, model })` — the model rides in the
   * SECOND argument, alongside the adapter it has to be compatible with. That
   * pairing is the whole reason a fleet id cannot travel here.
   */
  function dispatchedModel(): string {
    const opts = client.startRun.mock.calls[0]?.[1] as { model?: string } | undefined;
    return opts?.model ?? '';
  }

  it.each(FLEET_ONLY)('does not forward the fleet-only model %s', async (model) => {
    await dispatchTaskToPostHogCode(task({ model }), env);
    // Never the fleet's id. Anything PostHog's `claude` adapter knows is fine —
    // what must not happen is the 400 that verbatim forwarding earned.
    expect(dispatchedModel()).not.toBe(model);
    expect(POSTHOG_IDS.has(dispatchedModel())).toBe(true);
  });

  it('still honours a model PostHog CAN run', async () => {
    // The guard must not flatten a deliberate choice. `claude-sonnet-4-6` is in
    // both catalogues, so a task pinned to it keeps it.
    await dispatchTaskToPostHogCode(task({ model: 'claude-sonnet-4-6' }), env);
    expect(dispatchedModel()).toBe('claude-sonnet-4-6');
  });

  it('falls through to the default when the task names no model', async () => {
    await dispatchTaskToPostHogCode(task({}), env);
    expect(POSTHOG_IDS.has(dispatchedModel())).toBe(true);
  });

  it.each([
    { name: 'a fleet-only pin that was replaced', metadata: { model: 'claude-fable-5-1' } },
    { name: 'a pin PostHog can run', metadata: { model: 'claude-sonnet-4-6' } },
    { name: 'no pin', metadata: {} },
  ])('tells clients the model that actually ran: $name', async ({ metadata }) => {
    await dispatchTaskToPostHogCode(task(metadata), env);
    expect(emitTaskUpdate).toHaveBeenCalledWith('ws1', 'task-1', {
      metadata: { posthogModel: dispatchedModel() },
    });
  });
});
