import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import type { CloudProviderType, FleetAgent } from '@talyn/shared';
import { failoverExhaustedRun, nextHop } from '../services/cloudProviders/quotaFailover.js';
import { heldBackAccounts, heldBackAgents } from '../services/selfHosted/exhaustedQuota.js';
import { addFleetAccount, setFleetAccountUsage } from '../services/selfHosted/accounts.js';
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
  tasks as tasksTable,
} from '../db/schema.js';

/**
 * Failover between ACCOUNTS of one agent.
 *
 * A run that dies of a usage limit or a spent subscription tries the next
 * account of the same agent first: another subscription of the same vendor is
 * the closest substitute, and the model (which carries the vendor) does not
 * change. Only when that agent has no free account left does the run move to
 * the other agent, then down the provider chain as before.
 */

const DETAIL = 'harness_no_output: 400 {"error":{"message":"You\'re out of extra usage."}}';
const RATE_LIMIT = "rate_limited: Rate limited by the Anthropic API — the account's limit";

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

describe('failover between fleet accounts', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let encrypt: (v: string) => unknown;
  const originals = new Map<CloudProviderType, CloudTaskProvider | null>();
  const savedKey = process.env.TALYN_TOKEN_KEY;

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    ({ encryptString: encrypt } = await import('../services/tokenCrypto.js'));
    // The vendor confirms the exhaustion when asked.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: "You're out of extra usage." } }),
        { status: 400 },
      ),
    );
    ({ db, cleanup } = await createTestDb());
    taskQueueService.resetForTests();
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.com' });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: { defaultCloudProvider: 'selfhosted', fleetSwitchAtPercent: 95 },
    });
    await db.insert(environmentsTable).values([
      { id: 'fleet1', ownerId: TEST_USER_ID, name: 'Talyn Fleet', type: 'selfhosted', status: 'connected', config: { type: 'selfhosted' } },
      { id: 'ph1', ownerId: TEST_USER_ID, name: 'PostHog Code', type: 'posthog_code', status: 'connected', config: { type: 'posthog_code' } },
    ]);
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'a/b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    for (const t of ['selfhosted', 'posthog_code'] as CloudProviderType[]) {
      originals.set(t, getCloudProvider(t));
      registerCloudProvider(fakeProvider(t));
    }
    process.env.FLEET_ALLOWED = 'true';
    resetFeatureFlagsForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    taskQueueService.shutdown();
    taskQueueService.resetForTests();
    for (const [, p] of originals) if (p) registerCloudProvider(p);
    originals.clear();
    await cleanup();
    delete process.env.FLEET_ALLOWED;
    resetFeatureFlagsForTests();
    if (savedKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = savedKey;
  });

  async function add(agent: FleetAgent, label: string, usedPercent?: number) {
    const account = await addFleetAccount('ws1', {
      kind: agent === 'claude' ? 'anthropic_key' : 'openai_key',
      credential: { keyEnc: encrypt(`key-${label}`) as never },
      label,
    });
    if (usedPercent !== undefined) {
      await setFleetAccountUsage(account.id, {
        fetchedAt: new Date().toISOString(),
        windows: [{ key: 'session', label: '5-hour', usedPercent, resetsAt: null }],
      });
    }
    return account;
  }

  async function seedTask(accountId?: string) {
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 'run',
      description: 'd',
      prompt: 'do',
      repositoryId: 'repo1',
      assignedEnvironmentId: 'fleet1',
      metadata: {
        model: 'claude-sonnet-5',
        cloudTask: {
          status: 'failed',
          extra: { llm: 'anthropic', model: 'claude-sonnet-5', ...(accountId ? { accountId } : {}) },
        },
      },
    });
  }

  async function task() {
    const [row] = await db
      .select({ status: tasksTable.status, metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'));
    return { status: row!.status, metadata: (row!.metadata ?? {}) as Record<string, unknown> };
  }

  describe('nextHop', () => {
    it.each([
      ['an exhaustion', false],
      ['a rate limit', true],
    ])('after %s, tries the same agent’s next account first', async (_label, fleetOnly) => {
      const a = await add('claude', 'A');
      const b = await add('claude', 'B');
      await add('codex', 'C');
      const hop = await nextHop('ws1', new Set([`fleet:claude:${a.id}`]), {
        fleetOnly,
        sameAgent: 'claude',
      });
      expect(hop).toEqual({ kind: 'fleet', agent: 'claude', accountId: b.id, accountLabel: 'B' });
    });

    it('skips a same-agent account that is over the threshold', async () => {
      const a = await add('claude', 'A');
      await setFleetAccountUsage(a.id, { fetchedAt: new Date().toISOString(), error: 'x' });
      await add('claude', 'B', 96);
      const c = await add('codex', 'C');
      const hop = await nextHop('ws1', new Set([`fleet:claude:${a.id}`]), { sameAgent: 'claude' });
      expect(hop).toMatchObject({ kind: 'fleet', agent: 'codex', accountId: c.id });
    });

    it('reads a bare agent hop as every account of that agent', async () => {
      await add('claude', 'A');
      await add('claude', 'B');
      const c = await add('codex', 'C');
      const hop = await nextHop('ws1', new Set(['fleet:claude']), { sameAgent: 'claude' });
      expect(hop).toMatchObject({ kind: 'fleet', agent: 'codex', accountId: c.id });
    });

    it('stops at the fleet for a rate limit when every account is tried', async () => {
      const a = await add('claude', 'A');
      const c = await add('codex', 'C');
      const hop = await nextHop('ws1', new Set([`fleet:claude:${a.id}`, `fleet:codex:${c.id}`]), {
        fleetOnly: true,
        sameAgent: 'claude',
      });
      expect(hop).toBeNull();
    });
  });

  describe('failoverExhaustedRun', () => {
    it('moves an exhausted run to the next account, keeps the model, and holds only the spent account', async () => {
      const a = await add('claude', 'A');
      await add('claude', 'B');
      await add('codex', 'C');
      await seedTask(a.id);

      expect(
        await failoverExhaustedRun({ taskId: 't1', workspaceId: 'ws1', exhausted: 'claude', detail: DETAIL }),
      ).toBe(true);

      const t = await task();
      expect(t.status).toBe('queued');
      expect(t.metadata.model).toBe('claude-sonnet-5');
      expect(t.metadata.quotaFailover).toMatchObject({
        tried: [`fleet:claude:${a.id}`],
        movedTo: 'B (Claude) on Talyn Fleet',
      });
      expect(Object.keys(await heldBackAccounts('ws1'))).toEqual([a.id]);
      expect(await heldBackAgents('ws1')).toEqual({});
    });

    it('moves a rate-limited run to the next account and writes no hold', async () => {
      const a = await add('claude', 'A');
      await add('claude', 'B');
      await seedTask(a.id);

      expect(
        await failoverExhaustedRun({
          taskId: 't1',
          workspaceId: 'ws1',
          exhausted: 'claude',
          detail: RATE_LIMIT,
          reason: 'rate_limited',
        }),
      ).toBe(true);
      const t = await task();
      expect(t.status).toBe('queued');
      expect(t.metadata.quotaFailover).toMatchObject({ movedTo: 'B (Claude) on Talyn Fleet' });
      expect(await heldBackAccounts('ws1')).toEqual({});
    });

    it('moves to the other agent when the same agent has no other account', async () => {
      const a = await add('claude', 'A');
      await add('codex', 'C');
      await seedTask(a.id);

      await failoverExhaustedRun({ taskId: 't1', workspaceId: 'ws1', exhausted: 'claude', detail: DETAIL });
      const t = await task();
      expect(t.metadata.quotaFailover).toMatchObject({ movedTo: 'Codex on Talyn Fleet' });
      expect(String(t.metadata.model)).toMatch(/^gpt-/);
    });

    it('treats a run with no recorded account as the whole agent', async () => {
      await add('claude', 'A');
      await add('claude', 'B');
      await add('codex', 'C');
      await seedTask();

      await failoverExhaustedRun({ taskId: 't1', workspaceId: 'ws1', exhausted: 'claude', detail: DETAIL });
      const t = await task();
      expect(t.metadata.quotaFailover).toMatchObject({ tried: ['fleet:claude'], movedTo: 'Codex on Talyn Fleet' });
    });
  });
});
