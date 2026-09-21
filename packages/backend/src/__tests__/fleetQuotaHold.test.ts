import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import type { Task, Environment, FleetAgent } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  integrations as integrationsTable,
} from '../db/schema.js';

/**
 * The hold, enforced where it saves the money.
 *
 * quotaFailover.test.ts proves a run that DIED of an exhausted quota moves on.
 * This proves the next task does not have to die to learn the same thing: the
 * fleet's dispatch reads the hold and either swaps agent or refuses as
 * capacity, and in neither case does a microVM get booted.
 *
 * The assertion is deliberately "was the fleet asked to create a sandbox, and
 * at which model", not "did the whole dispatch succeed". Those come apart the
 * moment the check is moved below the create — the regression that would make
 * the hold cost-free in name only — and the rest of the dispatch path (PR
 * linking, metadata, the sandbox's own lifecycle) is other tests' business.
 */

const createSandbox = vi.fn();

vi.mock('../services/selfHosted/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/client.js')>(
    '../services/selfHosted/client.js',
  );
  return {
    ...actual,
    FleetClient: class {
      createSandbox = createSandbox;
    },
  };
});

vi.mock('../services/github.js', () => ({
  githubService: { getVerifiedAccessToken: vi.fn(async () => 'gho_token') },
}));

const { dispatchTaskToFleet } = await import('../services/selfHosted/executor.js');
const { noteExhaustedAgent } = await import('../services/selfHosted/exhaustedQuota.js');

const ENV: Environment = {
  id: 'fleet1',
  name: 'Talyn Fleet',
  type: 'selfhosted',
  status: 'connected',
  config: { type: 'selfhosted' },
} as unknown as Environment;

function taskAt(model: string): Task {
  return {
    id: 't1',
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'queued',
    priority: 'medium',
    title: 'work',
    description: 'd',
    prompt: 'do the thing',
    repositoryId: 'repo1',
    metadata: { model },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
}

/** Give the workspace real (fake) tokens for these agents. */
async function connect(db: Database, agents: FleetAgent[]): Promise<void> {
  const config: Record<string, unknown> = {};
  // Pasted-key shapes rather than OAuth: `getSelfHostedCredentials` resolves
  // them without a vendor round trip, which is what this test wants.
  if (agents.includes('claude')) config.anthropicKeyEnc = encrypted('sk-ant-api-test');
  if (agents.includes('codex')) config.openaiKeyEnc = encrypted('sk-test-openai');
  await db.delete(integrationsTable).where(eq(integrationsTable.workspaceId, 'ws1'));
  await db.insert(integrationsTable).values({
    id: 'int1',
    workspaceId: 'ws1',
    type: 'selfhosted',
    enabled: true,
    config,
  });
}

let encrypted: (v: string) => unknown;
let priorTokenKey: string | undefined;

describe('a held-back agent never boots a sandbox', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    priorTokenKey = process.env.TALYN_TOKEN_KEY;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    ({ db, cleanup } = await createTestDb());
    ({ encryptString: encrypted } = await import('../services/tokenCrypto.js'));
    createSandbox.mockReset();
    createSandbox.mockResolvedValue({ id: 'sb1', status: 'running' });
    process.env.FLEET_API_TOKEN = 'fleet-token';
    process.env.FLEET_PINNED_ENDPOINT = 'https://fleet.test';
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.com' });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'a/b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    await db.insert(environmentsTable).values({
      id: 'fleet1',
      ownerId: TEST_USER_ID,
      name: 'Talyn Fleet',
      type: 'selfhosted',
      status: 'connected',
      config: { type: 'selfhosted' },
    });
  });

  afterEach(async () => {
    await cleanup();
    if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorTokenKey;
    delete process.env.FLEET_API_TOKEN;
    delete process.env.FLEET_PINNED_ENDPOINT;
  });

  it('refuses as CAPACITY when the held agent is the only one connected', async () => {
    await connect(db, ['claude']);
    await noteExhaustedAgent('ws1', 'claude', "You're out of extra usage.");

    const result = await dispatchTaskToFleet(taskAt('claude-sonnet-5'), ENV);

    expect(result.ok).toBe(false);
    // `capacity` is how the task queue is told "nothing is wrong with this
    // task, try the next provider" — it is what routes the work to PostHog
    // Code. A plain failure would strand it here.
    expect(result.ok === false && result.capacity).toBe(true);
    expect(result.ok === false && result.error).toContain('exhausted');
    // The whole point: no microVM.
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it('swaps onto the other connected agent rather than refusing', async () => {
    await connect(db, ['claude', 'codex']);
    await noteExhaustedAgent('ws1', 'claude', "You're out of extra usage.");

    await dispatchTaskToFleet(taskAt('claude-sonnet-5'), ENV);

    expect(createSandbox).toHaveBeenCalledTimes(1);
    // The model is what carries the vendor, so the swap has to show up there —
    // the host builds the sandbox's egress route table from it.
    const body = createSandbox.mock.calls[0]![0] as { task?: { model?: string } };
    expect(String(body.task?.model)).toMatch(/gpt/);
  });

  it('dispatches normally once the hold has lapsed', async () => {
    await connect(db, ['claude']);
    await noteExhaustedAgent('ws1', 'claude', "You're out of extra usage.");
    // Backdate the record just past its probe window. Six MINUTES, not the six
    // hours this used to use: the window is now a burst-collapsing five
    // minutes, and a test that overshoots it by hours stops proving where the
    // boundary is.
    const rows = await db
      .select({ id: integrationsTable.id, config: integrationsTable.config })
      .from(integrationsTable)
      .where(eq(integrationsTable.workspaceId, 'ws1'))
      .limit(1);
    const config = rows[0]!.config as { quotaExhausted?: Record<string, { at: string }> };
    config.quotaExhausted!.claude!.at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await db
      .update(integrationsTable)
      .set({ config })
      .where(eq(integrationsTable.id, rows[0]!.id));

    await dispatchTaskToFleet(taskAt('claude-sonnet-5'), ENV);

    expect(createSandbox).toHaveBeenCalledTimes(1);
    const body = createSandbox.mock.calls[0]![0] as { task?: { model?: string } };
    // Back on the model the task asked for — the probe IS the next ordinary
    // dispatch, not a special code path.
    expect(body.task?.model).toBe('claude-sonnet-5');
  });

  it('leaves an unheld workspace completely alone', async () => {
    await connect(db, ['claude']);
    await dispatchTaskToFleet(taskAt('claude-sonnet-5'), ENV);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    const body = createSandbox.mock.calls[0]![0] as { task?: { model?: string } };
    expect(body.task?.model).toBe('claude-sonnet-5');
  });
});
