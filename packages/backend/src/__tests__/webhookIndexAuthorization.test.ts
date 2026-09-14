import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
} from '../db/schema.js';
import { githubService, GitHubAuthorizationUnavailableError } from '../services/github.js';
import {
  allWatchedRepoFullNames,
  isRepoWatchedSync,
  refreshWebhookIndex,
  targetsForRepo,
  _resetWebhookIndex,
} from '../services/webhookIndex.js';

vi.mock('../services/github.js', async () => {
  const actual = await vi.importActual<typeof import('../services/github.js')>(
    '../services/github.js'
  );
  return {
    ...actual,
    githubService: { canAccessRepository: vi.fn() },
  };
});

/**
 * Authorization belongs to the index build, not to a delivery.
 *
 * Watching a repo is not permission to read it — a `repositories` row outlives
 * a user's access — so recipients have to be re-checked against GitHub. That
 * check used to run per delivery per candidate workspace, and because
 * `canAccessRepository` re-reads the credential from `integrations` every call
 * by design, 17 workspaces watching PostHog/posthog at 8-20 deliveries/s came
 * to ~136 credential reads a second. The webhook queue fell 56 minutes behind,
 * far enough that Redis began trimming deliveries off the back of the stream.
 *
 * These tests pin the two halves that make moving it safe: the fan-out is still
 * filtered by authorization, and asking for it costs a delivery nothing.
 */
describe('webhookIndex — authorization is decided at build time', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const access = vi.mocked(githubService.canAccessRepository);

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: 'owner-b', email: 'b@example.test' });
    await db.insert(workspacesTable).values([
      { id: 'wsA', ownerId: TEST_USER_ID, name: 'A', settings: {} },
      { id: 'wsB', ownerId: 'owner-b', name: 'B', settings: {} },
    ]);
    await db.insert(repositoriesTable).values([
      { id: 'rA', workspaceId: 'wsA', name: 'acme/widget', url: 'https://github.com/acme/widget', defaultBranch: 'main' },
      { id: 'rB', workspaceId: 'wsB', name: 'acme/widget', url: 'https://github.com/acme/widget', defaultBranch: 'main' },
    ]);
    _resetWebhookIndex();
    access.mockReset();
  });

  afterEach(async () => {
    _resetWebhookIndex();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('costs a delivery nothing — the whole point of the change', async () => {
    access.mockResolvedValue(true);
    await refreshWebhookIndex();
    access.mockClear();

    // A hundred deliveries for the same repo, as the check firehose produces.
    for (let i = 0; i < 100; i++) await targetsForRepo('acme/widget');

    expect(access).not.toHaveBeenCalled();
  });

  it('still filters the fan-out to the workspaces GitHub confirmed', async () => {
    access.mockImplementation(async (ws: string) => ws === 'wsA');
    await refreshWebhookIndex();

    expect((await targetsForRepo('acme/widget')).map((t) => t.workspaceId)).toEqual(['wsA']);
  });

  it('asks once per workspace per build, not once per delivery', async () => {
    access.mockResolvedValue(true);
    await refreshWebhookIndex();
    expect(access).toHaveBeenCalledTimes(2); // wsA + wsB, once each
  });

  it('picks up a revoked workspace on the next build', async () => {
    access.mockResolvedValue(true);
    await refreshWebhookIndex();
    expect(await targetsForRepo('acme/widget')).toHaveLength(2);

    // Access goes away. The old per-delivery check was effectively 60s fresh
    // (canAccessRepository caches its decision that long); a rebuild is 30s.
    access.mockImplementation(async (ws: string) => ws === 'wsA');
    await refreshWebhookIndex();

    expect((await targetsForRepo('acme/widget')).map((t) => t.workspaceId)).toEqual(['wsA']);
  });

  it('serves the workspaces it could verify when another cannot answer', async () => {
    // A credential outage is not a refusal, and one workspace that cannot
    // answer must not silence the others.
    access.mockImplementation(async (ws: string) => {
      if (ws === 'wsB') throw new GitHubAuthorizationUnavailableError();
      return true;
    });
    await refreshWebhookIndex();

    expect((await targetsForRepo('acme/widget')).map((t) => t.workspaceId)).toEqual(['wsA']);
  });

  it('parks the delivery when NOBODY could be asked', async () => {
    // Distinguished from "nobody may see this", which is an empty list and a
    // dropped delivery. This one has to be retried.
    access.mockRejectedValue(new GitHubAuthorizationUnavailableError());
    await refreshWebhookIndex();

    await expect(targetsForRepo('acme/widget')).rejects.toBeInstanceOf(
      GitHubAuthorizationUnavailableError
    );
  });

  it('returns an empty list — not an error — when everyone is refused', async () => {
    access.mockResolvedValue(false);
    await refreshWebhookIndex();

    expect(await targetsForRepo('acme/widget')).toEqual([]);
  });

  it('keeps the receiver-side view on WATCHED repos, not authorized ones', async () => {
    // `isRepoWatchedSync` and the head-SHA reseeder answer "is this a repo we
    // know about", which is not a permission question — it must not change
    // when one workspace's credential lapses.
    access.mockResolvedValue(false);
    await refreshWebhookIndex();

    expect(isRepoWatchedSync('acme/widget')).toBe(true);
    expect(allWatchedRepoFullNames()).toContain('acme/widget');
  });

  it('knows nothing about a repo nobody watches', async () => {
    access.mockResolvedValue(true);
    await refreshWebhookIndex();

    expect(await targetsForRepo('acme/other')).toEqual([]);
    expect(isRepoWatchedSync('acme/other')).toBe(false);
  });
});
