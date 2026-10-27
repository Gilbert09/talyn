import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { buildBlocks } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet, claudeTurnLines } from './helpers/fakeFleet.js';
import { pullRequests, repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { githubService } from '../services/github.js';
import * as graphql from '../services/githubGraphql.js';
import type { PRSummary } from '../services/githubGraphql.js';
import { prMonitorService } from '../services/prMonitor.js';
import { _awaitCheckLedgerReseeds, upsertFromBatchResult } from '../services/prCache.js';
import { _resetCoalesce, processWebhookDelivery } from '../services/webhookWorker.js';
import { _resetWebhookIndex, refreshWebhookIndex } from '../services/webhookIndex.js';
import { autoArchiveForMergedPr, sweepMergeArchives } from '../services/workbenches/autoArchive.js';
import { restoreWorkbench, settleArchivesForTests } from '../services/workbenches/lifecycle.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import { claimOrEnqueue, finishTurn, getChat, getWorkbench, insertChat, insertWorkbench,
  listEvents, updateWorkbench } from '../services/workbenches/store.js';
import { sweepOrphanedTurns, turnLogKey } from '../services/workbenches/turns.js';
import { durablePaths } from '../services/workbenches/durableExec.js';
import * as changes from '../services/workbenches/changes.js';
import * as prSessions from '../services/workbenches/prSessions.js';
import * as emit from '../services/workbenches/emit.js';

vi.mock('../services/websocket.js', async (original) => ({
  ...await original<typeof import('../services/websocket.js')>(), broadcastToWorkspace: vi.fn(),
}));
vi.mock('../services/workflows/engine.js', () => ({ evaluateWorkflowsForDelivery: async () => undefined }));
vi.mock('../services/workbenches/agentBackups.js', async (original) => ({
  ...await original<typeof import('../services/workbenches/agentBackups.js')>(), scheduleAgentBackup: vi.fn(),
}));

const createdAt = new Date(Date.now() - 3 * 3600_000);
const linkedAt = new Date(Date.now() - 90 * 60_000);
const mergedAt = new Date(Date.now() - 60 * 60_000);
const note = 'The pull request was merged, so Talyn archived this session.';
const message = (id: string) => ({ id, text: id, queuedAt: new Date().toISOString() });

function mergedSummary(): PRSummary {
  return {
    owner: 'acme', repo: 'widget', number: 7, title: 'Change', body: '', changedFiles: 1,
    url: 'https://github.com/acme/widget/pull/7', author: 'me', draft: false, state: 'merged',
    mergedAt: mergedAt.toISOString(), closedAt: mergedAt.toISOString(), headBranch: 'branch',
    baseBranch: 'main', headSha: 'sha', createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), updatedAt: mergedAt.toISOString(),
    mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: null, blockingReason: null,
    checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 }, unresolvedReviewThreads: 0,
    checkDigest: 'sha:', recentReviews: [], recentReviewComments: [], recentComments: [],
  };
}

describe('archive sessions after a PR merge', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  let releases: Array<() => void>;

  async function seedSession(id: string, workspaceId = 'ws', repositoryId = 'repo', number = 7, repo = 'widget') {
    const prId = `pr-${id}`;
    await testDb.db.insert(pullRequests).values({ id: prId, workspaceId, repositoryId,
      owner: 'acme', repo, number, state: 'open', lastSummary: { headBranch: 'branch', createdAt: createdAt.toISOString() } });
    await insertWorkbench({ id, workspaceId, repositoryId, repoFullName: `acme/${repo}`, name: id,
      branch: 'branch', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      createdAt, sandboxId: `box-${id}`, sandboxState: 'running', pullRequestId: prId, settings: { autoCreatePr: false } });
    await testDb.db.update(workbenches).set({ pullRequestLinkedAt: linkedAt }).where(eq(workbenches.id, id));
    await insertChat({ id: `chat-${id}`, workbenchId: id, workspaceId, title: 'Chat', agent: 'claude' });
  }

  const deliver = (merged = true) => processWebhookDelivery({
    deliveryId: 'same-delivery', eventType: 'pull_request', action: 'closed', repoFullName: 'acme/widget',
    enqueuedAtMs: 0, payload: { pull_request: { number: 7, merged,
      merged_at: merged ? mergedAt.toISOString() : null } },
  });
  const row = async () => (await getWorkbench('wb'))!;
  const notes = async () => (await listEvents('chat-wb', 0, 100)).events.filter(
    (event) => event.event.type === 'system' && event.event.subtype === 'pr_merged_archive',
  );

  beforeEach(async () => {
    releases = [];
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Workspace' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'acme/widget', url: 'https://github.com/acme/widget' });
    await seedSession('wb');
    fleet = new FakeFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    vi.spyOn(githubService, 'canAccessRepository').mockResolvedValue(true);
    vi.spyOn(prMonitorService, 'refreshPrAcrossWorkspaces').mockResolvedValue(undefined);
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (wb) => wb);
    vi.spyOn(prSessions, 'notifyPrSessionChanged').mockImplementation(() => undefined);
    _resetWebhookIndex();
    await refreshWebhookIndex();
    _resetCoalesce();
  });

  afterEach(async () => {
    releases.forEach((release) => release());
    await settleArchivesForTests();
    await _awaitCheckLedgerReseeds();
    setWorkbenchFleetClientForTests(null);
    _resetWebhookIndex();
    _resetCoalesce();
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  it.each([false, true])('archives only merged webhooks: merged=%s', async (merged) => {
    const updated = vi.spyOn(emit, 'emitWorkbenchUpdated');
    await deliver(merged);
    expect(Boolean((await row()).archivedAt)).toBe(merged);
    expect(await notes()).toHaveLength(merged ? 1 : 0);
    if (merged) {
      expect((await notes())[0].event).toMatchObject({ type: 'system', text: note });
      expect(buildBlocks((await notes()).map((entry) => entry.event))).toEqual([
        expect.objectContaining({ kind: 'system', text: note }),
      ]);
      expect(updated).toHaveBeenCalledWith(expect.objectContaining({ id: 'wb', status: 'archived' }));
      expect((await row()).settings).toMatchObject({ autoArchivedForPr: ['acme/widget#7'] });
      await settleArchivesForTests();
      expect(fleet.deleted).toEqual(['box-wb']);
    }
  });

  it('archives once for concurrent copies of the same delivery', async () => {
    await Promise.all([deliver(), deliver()]);
    await settleArchivesForTests();
    expect(await notes()).toHaveLength(1);
    expect(fleet.deleted).toEqual(['box-wb']);
  });

  it('leaves a restored session open for the same PR', async () => {
    fleet.handler = (script) => script.includes('PUSHED_BRANCH') ? { exitCode: 1, stderr: 'Try later' } : {};
    await deliver();
    await settleArchivesForTests();
    await restoreWorkbench('wb');
    expect((await row()).archivedAt).toBeNull();
    await deliver();
    await upsertFromBatchResult({ workspaceId: 'ws', repositoryId: 'repo', summary: mergedSummary() });
    expect((await row()).archivedAt).toBeNull();
    expect(await notes()).toHaveLength(1);
  });

  it('archives sessions in each owner workspace and leaves unrelated sessions alone', async () => {
    await seedUser(testDb.db, { id: 'other-owner', email: 'other@example.test' });
    await testDb.db.insert(workspaces).values({ id: 'ws2', ownerId: 'other-owner', name: 'Other' });
    await testDb.db.insert(repositories).values([
      { id: 'repo2', workspaceId: 'ws2', name: 'acme/widget', url: 'https://github.com/acme/widget' },
      { id: 'repo3', workspaceId: 'ws', name: 'acme/other', url: 'https://github.com/acme/other' },
    ]);
    await seedSession('other-owner', 'ws2', 'repo2');
    await seedSession('other-number', 'ws', 'repo', 8);
    await seedSession('other-repo', 'ws', 'repo3', 7, 'other');
    await insertWorkbench({ id: 'unlinked', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'acme/widget',
      name: 'unlinked', branch: 'branch', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready' });
    await refreshWebhookIndex();
    await deliver();
    expect((await getWorkbench('other-owner'))?.archivedAt).not.toBeNull();
    for (const id of ['other-number', 'other-repo', 'unlinked']) expect((await getWorkbench(id))?.archivedAt).toBeNull();
  });

  it('keeps webhook writes inside authorized owner workspaces', async () => {
    await seedUser(testDb.db, { id: 'denied-owner', email: 'denied@example.test' });
    await testDb.db.insert(workspaces).values({ id: 'denied', ownerId: 'denied-owner', name: 'Denied' });
    await testDb.db.insert(repositories).values({ id: 'denied-repo', workspaceId: 'denied',
      name: 'acme/widget', url: 'https://github.com/acme/widget' });
    await seedSession('denied-session', 'denied', 'denied-repo');
    vi.mocked(githubService.canAccessRepository).mockImplementation(async (workspaceId) => workspaceId !== 'denied');
    await refreshWebhookIndex();
    await deliver();
    expect((await row()).archivedAt).not.toBeNull();
    expect((await getWorkbench('denied-session'))?.archivedAt).toBeNull();
  });

  it.each(['monitor', 'refresh'] as const)('archives through the %s path without a webhook', async (path) => {
    if (path === 'monitor') {
      await prMonitorService.markPrTerminal([{ repositoryId: 'repo' }], 7, { merged: true, mergedAt: new Date() });
    } else {
      vi.spyOn(graphql, 'batchPullRequestsByNumber').mockResolvedValue([{ number: 7, pr: mergedSummary() }]);
      await prMonitorService.refreshPr('ws', 'acme', 'widget', 7);
    }
    expect((await row()).archivedAt).not.toBeNull();
    expect(await notes()).toHaveLength(1);
  });

  async function heldTurn(chatId: string) {
    const claimed = await claimOrEnqueue(chatId, message(`run-${chatId}`), true);
    expect(claimed?.started).not.toBeNull();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    fleet.durableLogs.set(durablePaths(turnLogKey(chatId, 1, 0)).log, {
      stdout: claudeTurnLines('session', 'Done'), hold,
    });
    await testDb.db.update(workbenchChats).set({ turnHeartbeatAt: new Date(0) }).where(eq(workbenchChats.id, chatId));
    return release;
  }

  it('waits for the last running chat and does not start queued messages', async () => {
    await insertChat({ id: 'second', workbenchId: 'wb', workspaceId: 'ws', title: 'Second', agent: 'claude' });
    const first = await heldTurn('chat-wb');
    const second = await heldTurn('second');
    await claimOrEnqueue('chat-wb', message('queued-first'), true);
    await claimOrEnqueue('second', message('queued-second'), true);
    expect(await sweepOrphanedTurns()).toBe(2);
    await vi.waitFor(() => expect(fleet.durableFollowOffsets.length).toBeGreaterThanOrEqual(2));
    await deliver();
    expect((await row()).archivedAt).toBeNull();
    expect((await row()).settings).toMatchObject({ archiveOnIdle: 'acme/widget#7' });
    expect(fleet.deleted).toEqual([]);
    first();
    await vi.waitFor(async () => expect((await getChat('chat-wb'))?.status).toBe('idle'));
    expect((await row()).archivedAt).toBeNull();
    expect((await getChat('chat-wb'))?.turnCount).toBe(1);
    second();
    await vi.waitFor(async () => expect((await row()).archivedAt).not.toBeNull());
    await vi.waitFor(() => expect(prSessions.notifyPrSessionChanged).toHaveBeenCalledTimes(2));
    expect((await getChat('second'))?.turnCount).toBe(1);
    expect(await notes()).toHaveLength(1);
    expect((await listEvents('second', 0, 100)).events.some((event) => event.event.subtype === 'pr_merged_archive')).toBe(false);
  });

  it('recovers a crash after the last turn commits', async () => {
    await claimOrEnqueue('chat-wb', message('running'), true);
    await deliver();
    await finishTurn('chat-wb', { finalStatus: 'idle', statusMessage: null, drain: true });
    expect((await row()).archivedAt).toBeNull();
    await sweepMergeArchives();
    expect((await row()).archivedAt).not.toBeNull();
    expect(await notes()).toHaveLength(1);
  });

  it('blocks a new turn while another chat waits for archive', async () => {
    await claimOrEnqueue('chat-wb', message('running'), true);
    await deliver();
    await insertChat({ id: 'new-chat', workbenchId: 'wb', workspaceId: 'ws', title: 'New', agent: 'claude' });
    expect((await claimOrEnqueue('new-chat', message('late'), true))?.started).toBeNull();
    await expect(testDb.db.execute(sql`UPDATE workbench_chats SET status = 'running', turn_count = turn_count + 1
      WHERE id = 'new-chat'`)).rejects.toThrow();
    expect((await getChat('new-chat'))?.status).toBe('idle');
  });

  it('keeps merge markers through stale settings writes', async () => {
    await claimOrEnqueue('chat-wb', message('running'), true);
    await deliver();
    await updateWorkbench('wb', { settings: { autoCreatePr: true } });
    expect((await row()).settings).toMatchObject({ archiveOnIdle: 'acme/widget#7', autoCreatePr: true });
    await finishTurn('chat-wb', { finalStatus: 'idle', statusMessage: null, drain: true });
    fleet.handler = (script) => script.includes('PUSHED_BRANCH') ? { exitCode: 1 } : {};
    await sweepMergeArchives();
    await settleArchivesForTests();
    await restoreWorkbench('wb');
    await updateWorkbench('wb', { settings: { autoCreatePr: false } });
    await deliver();
    expect((await row()).archivedAt).toBeNull();
    expect((await row()).settings).toMatchObject({ autoArchivedForPr: ['acme/widget#7'] });
    expect(await notes()).toHaveLength(1);
  });

  it('can archive a new linked PR without forgetting the previous PR', async () => {
    fleet.handler = (script) => script.includes('PUSHED_BRANCH') ? { exitCode: 1 } : {};
    await deliver();
    await settleArchivesForTests();
    await restoreWorkbench('wb');
    await testDb.db.insert(pullRequests).values({ id: 'new-pr', workspaceId: 'ws', repositoryId: 'repo',
      owner: 'acme', repo: 'widget', number: 8, state: 'merged', mergedAt: new Date(Date.now() + 60_000),
      lastSummary: { createdAt: new Date().toISOString() } });
    await updateWorkbench('wb', { pullRequestId: 'new-pr' });
    await autoArchiveForMergedPr({ repoFullName: 'acme/widget', number: 8 });
    expect((await row()).settings).toMatchObject({ autoArchivedForPr: ['acme/widget#7', 'acme/widget#8'] });
    await settleArchivesForTests();
    await restoreWorkbench('wb');
    await updateWorkbench('wb', { pullRequestId: 'pr-wb' });
    await deliver();
    expect((await row()).archivedAt).toBeNull();
    expect(await notes()).toHaveLength(2);
  });

  it('keeps the move active until its existing archive handling takes over', async () => {
    await updateWorkbench('wb', { status: 'moving', settings: { moveSandboxId: 'new-box' } });
    await autoArchiveForMergedPr({ repoFullName: 'ACME/Widget', number: 7, mergedAt });
    expect(await row()).toMatchObject({ status: 'moving', archivePendingAt: expect.any(Date),
      settings: { moveSandboxId: 'new-box', autoArchivedForPr: ['acme/widget#7'] } });
    await settleArchivesForTests();
    expect(fleet.deleted).toEqual([]);
  });
});
