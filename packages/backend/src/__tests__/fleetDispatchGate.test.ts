import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskQueueService } from '../services/taskQueue.js';
import { registerCloudProvider, getCloudProvider } from '../services/cloudProviders/registry.js';
import type { CloudTaskProvider } from '../services/cloudProviders/types.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';

// The audience now lives in the `talyn-fleet` PostHog flag, so "this owner is
// not allowed" is a flag answer rather than an env string. Programmable per
// test; `undefined` is PostHog saying it has never heard of the flag.
let flagAnswer: () => boolean | undefined = () => undefined;

vi.mock('posthog-node', () => ({
  PostHog: class {
    async isFeatureEnabled() {
      return flagAnswer();
    }
    async shutdown() {
      /* no-op */
    }
  },
}));

const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

/**
 * The fleet audience, enforced at the point of work.
 *
 * fleetAccess.test.ts covers the predicate. This covers the thing that actually
 * protects the hardware: that a task whose workspace is not allowed never
 * reaches `provider.dispatch`, whatever put it in the queue.
 *
 * It is a separate file because the assertion is different in kind. The unit
 * test asks "does the function return false"; this asks "did the fleet get
 * called anyway" — and those come apart the moment someone adds a second
 * dispatch path, which is precisely how the billing clientGate ended up
 * protecting only the desktop renderer.
 */
function fakeFleetProvider(dispatch: CloudTaskProvider['dispatch']): CloudTaskProvider {
  return {
    type: 'selfhosted',
    displayName: 'Fake fleet',
    validateCredentials: vi.fn(async () => ({ ok: true })),
    hasCredentials: vi.fn(async () => true),
    removeCredentials: vi.fn(async () => {}),
    dispatch,
    reconcile: vi.fn(async () => {}),
    stopStreaming: vi.fn(() => {}),
  };
}

async function seed(db: Database, ownerEmail: string): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID, email: ownerEmail });
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'ws',
    settings: {},
  });
  await db.insert(environmentsTable).values({
    id: 'fleet1',
    ownerId: TEST_USER_ID,
    name: 'Self-hosted',
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
  const now = new Date();
  await db.insert(tasksTable).values({
    id: 't1',
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'queued',
    priority: 'medium',
    title: 'gated task',
    description: 'd',
    prompt: 'do',
    repositoryId: 'repo1',
    assignedEnvironmentId: 'fleet1',
    createdAt: now,
    updatedAt: now,
  });
}

describe('fleet dispatch gate', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let original: CloudTaskProvider | null;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    // The queue service is a singleton with a re-entry guard; without this a
    // previous suite in the same worker leaves it held and every dispatch here
    // silently no-ops.
    taskQueueService.resetForTests();
    original = getCloudProvider('selfhosted');
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    flagAnswer = () => undefined;
    resetFeatureFlagsForTests();
  });

  afterEach(async () => {
    taskQueueService.shutdown();
    taskQueueService.resetForTests();
    if (original) registerCloudProvider(original);
    await cleanup();
    delete process.env.FLEET_ALLOWED;
    delete process.env.TALYN_POSTHOG_KEY;
    resetFeatureFlagsForTests();
  });

  it('does not dispatch to the fleet when the workspace owner is outside the flag audience', async () => {
    await seed(db, 'mallory@example.com');
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeFleetProvider(dispatch));

    flagAnswer = () => false;
    resetFeatureFlagsForTests();

    await taskQueueService.processQueue();

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch when the flag does not exist, which is the deployment default', async () => {
    await seed(db, 'tom@example.com');
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeFleetProvider(dispatch));

    flagAnswer = () => undefined;
    resetFeatureFlagsForTests();

    // No flag means nobody. A backend deployed with FLEET_ENABLED=true and a
    // `talyn-fleet` flag nobody has created must serve the fleet to no one,
    // rather than to everyone.
    await taskQueueService.processQueue();

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch when the break-glass switch is pulled, whatever the flag says', async () => {
    await seed(db, 'tom@example.com');
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeFleetProvider(dispatch));

    flagAnswer = () => true;
    process.env.FLEET_ALLOWED = 'false';
    resetFeatureFlagsForTests();

    await taskQueueService.processQueue();

    expect(dispatch).not.toHaveBeenCalled();
  });

  // The positive leg. Without it every assertion above would still pass against
  // a dispatch path that was simply broken, and the gate would look like it
  // worked while the feature did not exist.
  it('DOES dispatch when the workspace owner is in the flag audience', async () => {
    await seed(db, 'tom@example.com');
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeFleetProvider(dispatch));

    flagAnswer = () => true;
    resetFeatureFlagsForTests();

    await taskQueueService.processQueue();

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('records the refusal on the task rather than leaving it silently queued', async () => {
    await seed(db, 'mallory@example.com');
    registerCloudProvider(fakeFleetProvider(vi.fn(async () => ({ ok: true as const }))));

    flagAnswer = () => false;
    resetFeatureFlagsForTests();

    await taskQueueService.processQueue();

    const rows = await db
      .select({ metadata: tasksTable.metadata, status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    // A task that is refused and left untouched is one nobody can explain: it
    // sits queued forever with no reason attached. The dispatch-failure
    // bookkeeping is what surfaces it.
    const meta = JSON.stringify(rows[0]?.metadata ?? {});
    expect(meta).toContain('audience');
  });
});
