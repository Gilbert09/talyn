import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { pullRequests, repositories, workbenches, workspaces } from '../db/schema.js';
import { githubService } from '../services/github.js';
import { allocateWorkbenchBranch } from '../services/workbenches/branchAllocation.js';
import { linkPullRequest } from '../services/workbenches/prLink.js';
import { autoArchiveForMergedPr } from '../services/workbenches/autoArchive.js';
import { backfillMergeArchives } from '../services/workbenches/mergeBackfill.js';
import { settleArchivesForTests } from '../services/workbenches/lifecycle.js';
import { getWorkbench, insertChat, insertWorkbench, listEvents, updateWorkbench } from '../services/workbenches/store.js';
import { orphanReason, reapWorkbenchSandboxes } from '../services/workbenches/reaper.js';
import { withMaintenanceClaim } from '../services/workbenches/maintenanceClaim.js';
import type { FleetClient, FleetSandbox } from '../services/selfHosted/client.js';

vi.mock('../services/websocket.js', async (original) => ({
  ...await original<typeof import('../services/websocket.js')>(), broadcastToWorkspace: vi.fn(),
}));
const now = Date.now();
const at = (minutes: number) => new Date(now + minutes * 60_000);

describe('session identity and cleanup', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Workspace' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
  });
  afterEach(async () => {
    await settleArchivesForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await testDb.cleanup();
  });
  const session = (id = 'wb', extra: Partial<typeof workbenches.$inferInsert> = {}) => insertWorkbench({
    id, name: id, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', branch: 'tom/change',
    baseBranch: 'main', runtime: 'local', agent: 'claude', status: 'ready', createdAt: at(-60), ...extra,
  });
  const pr = (extra: Partial<typeof pullRequests.$inferInsert> = {}) => testDb.db.insert(pullRequests).values({
    id: 'pr', workspaceId: 'ws', repositoryId: 'repo', owner: 'o', repo: 'r', number: 1, state: 'open',
    lastSummary: { headBranch: 'tom/change', headSha: 'abc', createdAt: at(-30).toISOString() }, ...extra,
  });

  it('skips archived names and remote branches, then takes the next suffix', async () => {
    await session('old', { archivedAt: at(-10) });
    await session('older', { branch: 'tom/change-2', archivedAt: at(-10) });
    const remote = vi.spyOn(githubService, 'branchExists').mockImplementation(async (_ws, _owner, _repo, branch) => branch === 'tom/change-3');
    expect(await allocateWorkbenchBranch('ws', 'o/r', 'tom/change')).toBe('tom/change-4');
    expect(remote.mock.calls.map((args) => args[3])).toEqual(['tom/change-3', 'tom/change-4']);
  });

  it.each([['2', '3'], ['99999999999999999999', '100000000000000000000']])(
    'continues numeric suffix %s', async (suffix, next) => {
      await session('old', { branch: `tom/change-${suffix}`, archivedAt: at(-10) });
      vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
      expect(await allocateWorkbenchBranch('ws', 'o/r', `tom/change-${suffix}`)).toBe(`tom/change-${next}`);
    },
  );

  it('reserves generated names across archived sessions', async () => {
    await session('old', { allocatedBranch: true, archivedAt: at(-10) });
    await expect(session('new', { allocatedBranch: true })).rejects.toThrow();
  });

  it.each([
    ['old merge', -120, 'merged', -90, [], false],
    ['old closed PR', -120, 'closed', -90, [], false],
    ['old open PR', -120, 'open', null, [], false],
    ['fresh PR', -30, 'open', null, [], true],
    ['clock skew', -61, 'open', null, [], true],
    ['pushed commit', -120, 'open', null, ['abc'], true],
    ['old merge with pushed commit', -120, 'merged', -90, ['abc'], false],
  ] as const)('links only eligible PRs: %s', async (_name, created, state, terminal, pushed, expected) => {
    const row = await session('wb', { pushedHeadShas: [...pushed] });
    await pr({ state, mergedAt: state === 'merged' ? at(terminal!) : null,
      lastSummary: { headBranch: row.branch, headSha: 'abc', createdAt: at(created).toISOString(),
        closedAt: terminal === null ? null : at(terminal).toISOString() } });
    const linked = await linkPullRequest(row);
    expect(linked.pullRequestId).toBe(expected ? 'pr' : null);
    expect(Boolean(linked.pullRequestLinkedAt)).toBe(expected);
  });

  it('does not archive a PR linked after its merge', async () => {
    await pr({ state: 'merged', mergedAt: at(-10) });
    await session('wb', { pullRequestId: 'pr' });
    await autoArchiveForMergedPr({ repoFullName: 'o/r', number: 1 });
    await backfillMergeArchives();
    expect((await getWorkbench('wb'))?.archivedAt).toBeNull();
  });

  it('backfills once and leaves a restored session open', async () => {
    await pr({ state: 'merged', mergedAt: at(-10) });
    await session('wb', { pullRequestId: 'pr' });
    await testDb.db.update(workbenches).set({ pullRequestLinkedAt: at(-20) }).where(eq(workbenches.id, 'wb'));
    await insertChat({ id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    await Promise.all([backfillMergeArchives(), backfillMergeArchives()]);
    await settleArchivesForTests();
    expect((await getWorkbench('wb'))?.archivedAt).not.toBeNull();
    await updateWorkbench('wb', { archivedAt: null, status: 'ready' });
    await backfillMergeArchives();
    expect((await getWorkbench('wb'))?.archivedAt).toBeNull();
    const notes = (await listEvents('chat', 0, 100)).events.filter((event) => event.event.subtype === 'pr_merged_archive');
    expect(notes).toHaveLength(1);
  });

  it('unlinks stale PRs and clears their pending merge marker', async () => {
    await pr({ state: 'merged', mergedAt: at(-90) });
    await session('wb', { pullRequestId: 'pr', settings: { archiveOnIdle: 'o/r#1' } });
    await backfillMergeArchives();
    expect(await getWorkbench('wb')).toMatchObject({ pullRequestId: null, pullRequestLinkedAt: null, settings: {}, archivedAt: null });
  });

  it.each([false, true])('reaps orphan classes and protects active work; dry run=%s', async (dryRun) => {
    vi.stubEnv('WORKBENCH_REAPER_DRY_RUN', dryRun ? '1' : '0');
    await session('live', { sandboxId: 'talyn-wb-live-r2', runtime: 'sandbox' });
    await session('archived', { sandboxId: 'talyn-wb-archived', archivedAt: at(-40) });
    await session('pending', { sandboxId: 'talyn-wb-pending', archivedAt: at(-40), archivePendingAt: at(-40) });
    await session('moving', { sandboxId: 'talyn-wb-moving', status: 'moving', settings: { moveSandboxId: 'talyn-wb-moving-r1' } });
    const entries = [
      ['talyn-wb-live-r1--suffix', -40], ['talyn-wb-archived--suffix', -40], ['talyn-wb-unknown--suffix', -1500],
      ['talyn-wb-live-r3--suffix', -40],
      ['talyn-wb-live-r2--suffix', -40], ['talyn-wb-moving-r1--suffix', -40], ['talyn-wb-pending--suffix', -40],
      ['fleet-task', -1500], ['talyn-wb-unknown-young', -40], ['talyn-wb-archived-r1', -10],
    ] as const;
    const sandboxes = entries.map(([id, minutes]) => ({ id, createdAt: at(minutes).toISOString(), status: 'suspended' as const }));
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);
    const client = { listSandboxes: vi.fn().mockResolvedValue({ sandboxes }), deleteSandbox } as unknown as FleetClient;
    await reapWorkbenchSandboxes(async () => [{ client, gateway: false }]);
    expect(deleteSandbox.mock.calls.map((args) => args[0])).toEqual(dryRun ? [] : entries.slice(0, 4).map(([id]) => id));
  });

  it('lists gateway tenant boxes and checks their host records', async () => {
    const box: FleetSandbox = { id: 'talyn-wb-adopted--suffix', status: 'idle', createdAt: at(-1500).toISOString(), adopted: true };
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);
    const client = { listGatewaySandboxes: vi.fn().mockResolvedValue({ sandboxes: [{ id: box.id, host: 'host' }] }),
      getSandbox: vi.fn().mockResolvedValue({ sandbox: box }), deleteSandbox } as unknown as FleetClient;
    await reapWorkbenchSandboxes(async () => [{ client, gateway: true }]);
    expect(deleteSandbox).toHaveBeenCalledWith(box.id);
  });

  it('allows only one reaper instance to list boxes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const listSandboxes = vi.fn(async () => { started(); await gate; return { sandboxes: [] }; });
    const clients = async () => [{ client: { listSandboxes } as unknown as FleetClient, gateway: false }];
    const first = reapWorkbenchSandboxes(clients);
    await entered;
    try { expect(await reapWorkbenchSandboxes(clients)).toBe(false); }
    finally { release(); }
    expect(await first).toBe(true);
    expect(listSandboxes).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired worker before its next side effect', async () => {
    await expect(withMaintenanceClaim('test', async (renew) => {
      await testDb.db.execute(sql`UPDATE workbench_maintenance_claims SET expires_at = now() - interval '1 minute'`);
      await renew();
    })).rejects.toThrow('claim expired');
  });

  it('keeps boxes without reliable age data', () => {
    expect(orphanReason({ id: 'talyn-wb-unknown' }, [])).toBeNull();
  });
});
