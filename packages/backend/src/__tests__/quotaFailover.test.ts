import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CloudProviderType, FleetAgent } from '@talyn/shared';
import { failoverExhaustedRun } from '../services/cloudProviders/quotaFailover.js';
import { registerCloudProvider, getCloudProvider } from '../services/cloudProviders/registry.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { taskQueueService } from '../services/taskQueue.js';
import type { CloudTaskProvider } from '../services/cloudProviders/types.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  integrations as integrationsTable,
  tasks as tasksTable,
} from '../db/schema.js';

/**
 * Moving a run whose own subscription is spent.
 *
 * The order under test is the product decision: the fleet's OTHER agent first
 * (a subscription the workspace has already paid for), then the metered
 * providers. Getting it backwards means stepping over a working Codex
 * subscription on the way to a bill, which is the whole reason this cannot
 * just defer to `resolveCloudEnvChain` — that resolver thinks in providers and
 * the fleet is one provider with two agents behind it.
 */

function fakeProvider(type: CloudProviderType): CloudTaskProvider {
  return {
    type,
    displayName: type === 'selfhosted' ? 'Talyn Fleet' : 'PostHog Code',
    validateCredentials: vi.fn(async () => ({ ok: true })),
    hasCredentials: vi.fn(async () => true),
    removeCredentials: vi.fn(async () => {}),
    dispatch: vi.fn(async () => ({ ok: true as const, remoteId: 'r1' })),
    reconcile: vi.fn(async () => {}),
    stopStreaming: vi.fn(() => {}),
  };
}

/** Whatever `fleetAgentStatus` should report for this workspace. */
async function connectAgents(
  db: Database,
  agents: FleetAgent[],
  opts: { reauth?: FleetAgent[] } = {},
): Promise<void> {
  const config: Record<string, unknown> = {};
  const reauth = opts.reauth ?? [];
  if (agents.includes('claude')) {
    config.claudeOAuth = reauth.includes('claude')
      ? { accessTokenEnc: 'x', reauthRequiredAt: new Date().toISOString() }
      : { accessTokenEnc: 'x' };
  }
  if (agents.includes('codex')) {
    config.codexOAuth = reauth.includes('codex')
      ? { accessTokenEnc: 'y', reauthRequiredAt: new Date().toISOString() }
      : { accessTokenEnc: 'y' };
  }
  await db
    .delete(integrationsTable)
    .where(eq(integrationsTable.workspaceId, 'ws1'));
  await db.insert(integrationsTable).values({
    id: 'int-fleet',
    workspaceId: 'ws1',
    type: 'selfhosted',
    enabled: true,
    config,
  });
}

const DETAIL =
  'harness_no_output: 400 {"error":{"message":"You\'re out of extra usage."}}';

describe('quota failover', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originals = new Map<CloudProviderType, CloudTaskProvider | null>();

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    taskQueueService.resetForTests();
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.com' });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: { defaultCloudProvider: 'selfhosted' },
    });
    await db.insert(environmentsTable).values([
      {
        id: 'fleet1',
        ownerId: TEST_USER_ID,
        name: 'Talyn Fleet',
        type: 'selfhosted',
        status: 'connected',
        config: { type: 'selfhosted' },
      },
      {
        id: 'ph1',
        ownerId: TEST_USER_ID,
        name: 'PostHog Code',
        type: 'posthog_code',
        status: 'connected',
        config: { type: 'posthog_code' },
      },
    ]);
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'a/b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    const now = new Date();
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 'exhausted run',
      description: 'd',
      prompt: 'do',
      repositoryId: 'repo1',
      assignedEnvironmentId: 'fleet1',
      metadata: { model: 'claude-sonnet-5', runAttempt: 1, cloudTask: { status: 'failed' } },
      createdAt: now,
      updatedAt: now,
    });
    for (const t of ['selfhosted', 'posthog_code'] as CloudProviderType[]) {
      originals.set(t, getCloudProvider(t));
      registerCloudProvider(fakeProvider(t));
    }
    process.env.FLEET_ALLOWED = 'true';
    resetFeatureFlagsForTests();
  });

  afterEach(async () => {
    taskQueueService.shutdown();
    taskQueueService.resetForTests();
    for (const [, p] of originals) if (p) registerCloudProvider(p);
    originals.clear();
    await cleanup();
    delete process.env.FLEET_ALLOWED;
    resetFeatureFlagsForTests();
  });

  async function task(): Promise<{
    status: string;
    assignedEnvironmentId: string | null;
    metadata: Record<string, unknown>;
    result: { summary?: string; error?: string } | null;
  }> {
    const rows = await db
      .select({
        status: tasksTable.status,
        assignedEnvironmentId: tasksTable.assignedEnvironmentId,
        metadata: tasksTable.metadata,
        result: tasksTable.result,
      })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    const row = rows[0]!;
    return {
      status: row.status,
      assignedEnvironmentId: row.assignedEnvironmentId,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      result: row.result as { summary?: string; error?: string } | null,
    };
  }

  const run = (exhausted: FleetAgent = 'claude') =>
    failoverExhaustedRun({ taskId: 't1', workspaceId: 'ws1', exhausted, detail: DETAIL });

  it('moves an exhausted Claude run to Codex on the fleet, not to PostHog Code', async () => {
    await connectAgents(db, ['claude', 'codex']);
    expect(await run()).toBe(true);

    const t = await task();
    expect(t.status).toBe('queued');
    // Still the fleet's env — the fleet is ONE provider, and the model is what
    // carries the vendor.
    expect(t.assignedEnvironmentId).toBe('fleet1');
    expect(String(t.metadata.model)).toMatch(/gpt/);
    expect(t.metadata.quotaFailover).toMatchObject({ movedTo: 'Codex on Talyn Fleet' });
  });

  it('falls through to PostHog Code when the fleet has no other agent', async () => {
    await connectAgents(db, ['claude']);
    expect(await run()).toBe(true);

    const t = await task();
    expect(t.status).toBe('queued');
    expect(t.assignedEnvironmentId).toBe('ph1');
    // The model is LEFT ALONE on a provider hop — PostHog Code's executor
    // already drops a fleet model id it does not accept.
    expect(t.metadata.model).toBe('claude-sonnet-5');
    expect(t.metadata.quotaFailover).toMatchObject({ movedTo: 'PostHog Code' });
  });

  it('skips a fleet agent that needs reconnecting rather than dying on it twice', async () => {
    await connectAgents(db, ['claude', 'codex'], { reauth: ['codex'] });
    expect(await run()).toBe(true);
    expect((await task()).assignedEnvironmentId).toBe('ph1');
  });

  it('bumps runAttempt, or the fleet hands back the sandbox that just died', async () => {
    await connectAgents(db, ['claude', 'codex']);
    await run();
    expect((await task()).metadata.runAttempt).toBe(2);
  });

  it('clears the finished run handles so dispatch starts a fresh one', async () => {
    await connectAgents(db, ['claude', 'codex']);
    await run();
    expect((await task()).metadata.cloudTask).toBeUndefined();
  });

  it('leaves result NULL on a move — a re-queued task must not paint as failed', async () => {
    await connectAgents(db, ['claude', 'codex']);
    await run();
    const t = await task();
    // The task detail renders any `result.success === false` as a red "Task
    // failed" banner whatever the status says. A task that moved has not
    // failed, so the note lives on the metadata instead.
    expect(t.result).toBeNull();
    expect(String((t.metadata.quotaFailover as { note?: string }).note)).toContain(
      'usage was exhausted',
    );
  });

  it('drops the dead run\'s transcript, so it is not read as the new run\'s output', async () => {
    await connectAgents(db, ['claude', 'codex']);
    await db
      .update(tasksTable)
      .set({ transcript: [{ type: 'assistant', text: 'from the run that ran out' }] })
      .where(eq(tasksTable.id, 't1'));
    await run();
    const rows = await db
      .select({ transcript: tasksTable.transcript })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    expect(rows[0]?.transcript).toBeNull();
  });

  it('never re-tries a hop already spent on this run', async () => {
    await connectAgents(db, ['claude', 'codex']);
    // Claude ran out, moved to Codex...
    expect(await run('claude')).toBe(true);
    // ...and Codex ran out too. The only place left is PostHog Code.
    expect(await run('codex')).toBe(true);
    const t = await task();
    expect(t.assignedEnvironmentId).toBe('ph1');
    expect(t.metadata.quotaFailover).toMatchObject({
      tried: ['fleet:claude', 'fleet:codex', 'posthog_code'],
    });
  });

  it('settles failed — not needs_human — when there is nowhere left to go', async () => {
    await connectAgents(db, ['claude']);
    await db.delete(environmentsTable).where(eq(environmentsTable.id, 'ph1'));
    expect(await run()).toBe(false);

    const t = await task();
    // `failed`, deliberately: needs_human means the AGENT stopped and handed
    // back a judgement call. This run never started.
    expect(t.status).toBe('failed');
    expect(t.result?.summary).toContain('Claude usage is exhausted');
    expect(t.result?.summary).toContain('Add usage');
  });

  it('leaves the workspace default model alone — a spent quota is not a preference', async () => {
    await connectAgents(db, ['claude', 'codex']);
    await run();
    const rows = await db
      .select({ settings: workspacesTable.settings })
      .from(workspacesTable)
      .where(eq(workspacesTable.id, 'ws1'))
      .limit(1);
    const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>;
    expect(settings.fleetModel).toBeUndefined();
    expect(settings.fleetModels).toBeUndefined();
  });

  it('is a no-op for a task that no longer exists', async () => {
    await connectAgents(db, ['claude', 'codex']);
    await db.delete(tasksTable).where(eq(tasksTable.id, 't1'));
    expect(
      await failoverExhaustedRun({
        taskId: 't1',
        workspaceId: 'ws1',
        exhausted: 'claude',
        detail: DETAIL,
      }),
    ).toBe(false);
  });
});
