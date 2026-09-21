// What `task_dispatched` says about the run it just started.
//
// `provider` alone cannot answer "what is my work running on": Talyn Fleet is
// ONE provider with two agents, and the MODEL is what picks between them. On
// 2026-09-21 an exhausted Claude subscription moved every task on a workspace
// onto Codex for a whole day, and in PostHog that was indistinguishable from a
// day of Claude — the model and the failover were both absent from the event.
//
// The subtle part, and the reason this exists: the facts are read out of the
// FRESH metadata inside `patchTaskMetadata`'s transform, not out of the task
// row the dispatch loop captured. The provider writes them while dispatching,
// so the captured copy predates them and reading it yields nulls — a
// regression that would look like "the property is just missing sometimes".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';
import { resetTodiexContextCacheForTests } from '../services/todiexContext.js';

const captured: Array<{ event: string; props: Record<string, unknown> }> = [];

vi.mock('../services/analytics.js', () => ({
  captureWorkspaceEvent: (_ws: string, event: string, props: Record<string, unknown> = {}) => {
    captured.push({ event, props });
  },
  captureServerEvent: async () => {},
}));

const { taskQueueService } = await import('../services/taskQueue.js');
const { registerCloudProvider, getCloudProvider } = await import(
  '../services/cloudProviders/registry.js'
);
const { patchTaskMetadata } = await import('../services/taskMetadataMutex.js');
type CloudTaskProvider = import('../services/cloudProviders/types.js').CloudTaskProvider;

/**
 * A fleet stand-in that does what the real dispatch does to the row: record
 * the model it ran at on `cloudTask.extra`. Everything else about the fleet
 * (microVMs, credentials, egress) is other tests' business.
 */
function fakeFleet(model: string): CloudTaskProvider {
  return {
    type: 'selfhosted',
    displayName: 'Talyn Fleet',
    validateCredentials: vi.fn(async () => ({ ok: true })),
    hasCredentials: vi.fn(async () => true),
    removeCredentials: vi.fn(async () => {}),
    dispatch: async (task) => {
      await patchTaskMetadata(task.id, (existing) => ({
        ...existing,
        cloudTask: { provider: 'selfhosted', extra: { model, llm: 'openai' } },
      }));
      return { ok: true };
    },
    reconcile: vi.fn(async () => {}),
    stopStreaming: vi.fn(() => {}),
  } as unknown as CloudTaskProvider;
}

describe('what the dispatch funnel is told about the run', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let original: CloudTaskProvider | undefined;

  beforeEach(async () => {
    captured.length = 0;
    // The audience gate, break-glassed: this is about what the event SAYS, and
    // a deployment-level gate refusing the dispatch would prove nothing.
    process.env.FLEET_ALLOWED = 'true';
    resetTodiexContextCacheForTests();
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(environmentsTable).values({
      id: 'fleet1',
      ownerId: TEST_USER_ID,
      name: 'Talyn Fleet',
      type: 'selfhosted',
      status: 'connected',
      config: { type: 'selfhosted' },
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'a/b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    original = getCloudProvider('selfhosted');
  });

  afterEach(async () => {
    delete process.env.FLEET_ALLOWED;
    if (original) registerCloudProvider(original);
    await cleanup();
  });

  async function dispatchOne(
    model: string,
    metadata: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    registerCloudProvider(fakeFleet(model));
    const now = new Date();
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'queued',
      priority: 'medium',
      title: 'work',
      description: 'd',
      prompt: 'do',
      repositoryId: 'repo1',
      assignedEnvironmentId: 'fleet1',
      metadata,
      createdAt: now,
      updatedAt: now,
    });
    await taskQueueService.processQueue();
    const dispatched = captured.find((c) => c.event === 'task_dispatched');
    expect(dispatched, 'no task_dispatched event was captured').toBeDefined();
    return dispatched!.props;
  }

  it('names the model the run actually started at', async () => {
    const props = await dispatchOne('gpt-5.6-sol');
    expect(props).toMatchObject({ provider: 'selfhosted', model: 'gpt-5.6-sol' });
  });

  it.each([
    ['gpt-5.6-sol', 'codex'],
    ['claude-sonnet-5', 'claude'],
  ])('reads the fleet agent off the model (%s → %s)', async (model, agent) => {
    expect(await dispatchOne(model)).toMatchObject({ fleet_agent: agent });
  });

  it('says when the run is only here because a quota ran out', async () => {
    // Without this, a day of failover work is indistinguishable from a day of
    // work on the agent the user actually chose.
    const props = await dispatchOne('gpt-5.6-terra', {
      quotaFailover: { exhausted: 'claude', movedTo: 'Codex on Talyn Fleet' },
    });
    expect(props).toMatchObject({ fleet_agent: 'codex', failed_over_from: 'claude' });
  });

  it('omits the fleet agent for a model that is not a fleet model', async () => {
    // `fleetAgentForModel` answers 'claude' for anything it does not know —
    // the back-compat answer a stale pin needs — so asking it about a PostHog
    // Code model would invent an agent for a run that has none.
    const props = await dispatchOne('claude-opus-4-8-posthog');
    expect(props).not.toHaveProperty('fleet_agent');
  });

  it('leaves the model out rather than guessing when the provider recorded none', async () => {
    registerCloudProvider({
      ...fakeFleet('unused'),
      dispatch: async () => ({ ok: true }),
    } as unknown as CloudTaskProvider);
    const now = new Date();
    await db.insert(tasksTable).values({
      id: 't2',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'queued',
      priority: 'medium',
      title: 'work',
      description: 'd',
      prompt: 'do',
      repositoryId: 'repo1',
      assignedEnvironmentId: 'fleet1',
      createdAt: now,
      updatedAt: now,
    });
    await taskQueueService.processQueue();
    const props = captured.find((c) => c.event === 'task_dispatched')!.props;
    expect(props).not.toHaveProperty('model');
    expect(props).not.toHaveProperty('fleet_agent');
  });

  it('is fed from the row as it is AFTER the dispatch, not before it', async () => {
    // The whole hazard in one assertion: the task was inserted with no model
    // at all, and the event still names the one the provider wrote while it
    // dispatched.
    const props = await dispatchOne('gpt-6-astra', {});
    expect(props.model).toBe('gpt-6-astra');
    const [row] = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    expect((row!.metadata as { cloudTask?: { extra?: { model?: string } } }).cloudTask?.extra?.model)
      .toBe('gpt-6-astra');
  });
});
