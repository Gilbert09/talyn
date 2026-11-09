import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultMobileNotificationPreferences, isMobileNotificationPayload } from '@talyn/shared';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { mergeQueueEntries, pullRequests, repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { mobileNotificationSourceEvents, notificationStillActionable, reconcileMobileNotificationEvents } from '../services/mobileNotificationEvents.js';
import { enqueueMobileNotification } from '../services/mobileNotifications/store.js';

vi.mock('../services/mobileNotifications/store.js', () => ({ enqueueMobileNotification: vi.fn(async () => undefined) }));

const owner = '00000000-0000-4000-8000-000000000001';
const workspace = '00000000-0000-4000-8000-000000000002';
const session = '00000000-0000-4000-8000-000000000003';
const repository = '00000000-0000-4000-8000-000000000004';
const chat = '00000000-0000-4000-8000-000000000005';
const pr = '00000000-0000-4000-8000-000000000006';
const prDestination = { kind: 'pull_request' as const, workspaceId: workspace, entityId: pr };
const baseline = { headSha: 'head-a', ciStatus: 'running', blockingReason: 'unknown', humanGates: [], reviewDecision: null };

describe('durable mobile transition journal', () => {
  let database: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { database = await createTestDb(); }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    vi.mocked(enqueueMobileNotification).mockReset().mockResolvedValue(undefined);
    await database.pglite.exec('DELETE FROM users');
    await seedUser(database.db, { id: owner });
    await database.db.insert(workspaces).values({ id: workspace, ownerId: owner, name: 'Workspace' });
    await database.db.insert(repositories).values({ id: repository, workspaceId: workspace, name: 'Repository', url: 'https://example.test/repository' });
    await database.db.insert(workbenches).values({ id: session, workspaceId: workspace, repositoryId: repository,
      name: 'session', repoFullName: 'fixture/repository', branch: 'branch', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready' });
    await database.db.insert(workbenchChats).values({ id: chat, workspaceId: workspace, workbenchId: session, title: 'Chat', agent: 'claude', status: 'running' });
    await database.db.insert(pullRequests).values({ id: pr, workspaceId: workspace, repositoryId: repository,
      owner: 'fixture', repo: 'repository', number: 1, state: 'open', authored: true, lastSummary: baseline });
    const preferences = { ...defaultMobileNotificationPreferences(workspace), enabled: true };
    await database.pglite.query('INSERT INTO mobile_notification_preferences(owner_id,workspace_id,preferences) VALUES($1,$2,$3)',
      [owner, workspace, JSON.stringify(preferences)]);
  });

  const events = () => database.db.select().from(mobileNotificationSourceEvents);
  const updateSummary = (patch: Record<string, unknown>) => database.db.update(pullRequests).set({ lastSummary: { ...baseline, ...patch } }).where(eq(pullRequests.id, pr));

  it.each([
    ['idle', ['session_update']], ['error', ['session_update']], ['awaiting_input', ['human_gate']],
  ])('records chat transition to %s once', async (status, categories) => {
    await database.db.update(workbenchChats).set({ status }).where(eq(workbenchChats.id, chat));
    await database.db.update(workbenchChats).set({ status }).where(eq(workbenchChats.id, chat));
    expect((await events()).map((row) => row.category).sort()).toEqual(categories);
  });

  it('captures rapid turns before the sweep and ignores transcript writes', async () => {
    await database.db.update(workbenchChats).set({ status: 'idle', turnCount: 1 }).where(eq(workbenchChats.id, chat));
    await database.db.update(workbenchChats).set({ status: 'running', turnCount: 2 }).where(eq(workbenchChats.id, chat));
    await database.db.update(workbenchChats).set({ nextSeq: 100 }).where(eq(workbenchChats.id, chat));
    await database.db.update(workbenchChats).set({ status: 'idle', turnCount: 2 }).where(eq(workbenchChats.id, chat));
    expect(await events()).toHaveLength(2);
  });

  it('records material input changes but stores no request text', async () => {
    await database.db.update(workbenchChats).set({ status: 'awaiting_input', statusMessage: 'Private request one' }).where(eq(workbenchChats.id, chat));
    await database.db.update(workbenchChats).set({ statusMessage: 'Private request two' }).where(eq(workbenchChats.id, chat));
    expect(await events()).toHaveLength(2);
    expect(JSON.stringify(await events())).not.toContain('Private request');
  });

  it('records a session failure without chat state', async () => {
    await database.db.update(workbenches).set({ status: 'error' }).where(eq(workbenches.id, session));
    expect((await events()).map((row) => row.category)).toEqual(['session_update']);
  });

  it.each([
    [{ reviewDecision: 'CHANGES_REQUESTED' }, 'pr_review'],
    [{ ciStatus: 'failing_required', blockingReason: 'checks_failed' }, 'ci_failure'],
    [{ blockingReason: 'mergeable' }, 'merge_ready'],
    [{ humanGates: [{ id: 'gate', name: 'Private check name', label: 'Private label', url: 'https://example.test/private' }] }, 'human_gate'],
  ])('records the %s category and suppresses unchanged polls', async (patch, category) => {
    await updateSummary(patch);
    await updateSummary(patch);
    expect((await events()).map((row) => row.category)).toEqual([category]);
    expect(JSON.stringify(await events())).not.toContain('Private');
  });

  it('records a new actionable review request once', async () => {
    await database.db.update(pullRequests).set({ reviewRequested: true }).where(eq(pullRequests.id, pr));
    await database.db.update(pullRequests).set({ reviewRequested: true }).where(eq(pullRequests.id, pr));
    expect((await events()).map((row) => row.category)).toEqual(['pr_review']);
  });

  it('groups repeated CI failures by PR and head commit', async () => {
    await updateSummary({ ciStatus: 'failing_required', blockingReason: 'checks_failed' });
    await updateSummary({ ciStatus: 'passing' });
    await updateSummary({ ciStatus: 'failing_required', blockingReason: 'checks_failed' });
    expect(await events()).toHaveLength(1);
    await updateSummary({ ciStatus: 'failing_required', blockingReason: 'checks_failed', headSha: 'head-b' });
    expect(await events()).toHaveLength(2);
    expect(JSON.stringify(await events())).not.toContain('head-a');
  });

  it('ignores gate order and records material gate changes', async () => {
    const gates = [{ id: 'one' }, { id: 'two' }];
    await updateSummary({ humanGates: gates });
    await updateSummary({ humanGates: [...gates].reverse() });
    expect(await events()).toHaveLength(1);
    await updateSummary({ humanGates: [{ id: 'three' }] });
    expect(await events()).toHaveLength(2);
  });

  it.each([
    { enabled: false }, { categories: { ...defaultMobileNotificationPreferences(workspace).categories, ci_failure: false } },
  ])('does not journal disabled notifications: %s', async (patch) => {
    await database.pglite.query('UPDATE mobile_notification_preferences SET preferences = preferences || $1::jsonb', [JSON.stringify(patch)]);
    await updateSummary({ ciStatus: 'failing_required' });
    expect(await events()).toHaveLength(0);
  });

  it('does not notify about untracked, closed, or draft-ready PRs', async () => {
    await updateSummary({ blockingReason: 'mergeable', draft: true });
    await database.db.update(pullRequests).set({ authored: false }).where(eq(pullRequests.id, pr));
    await updateSummary({ ciStatus: 'failing_required' });
    await database.db.update(pullRequests).set({ state: 'closed', reviewRequested: true }).where(eq(pullRequests.id, pr));
    expect(await events()).toHaveLength(0);
  });

  it('rolls the journal back with the authoritative change', async () => {
    await expect(database.db.transaction(async (tx) => {
      await tx.update(workbenchChats).set({ status: 'idle' }).where(eq(workbenchChats.id, chat));
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await events()).toHaveLength(0);
  });

  it('reconciles once with a generic validated payload', async () => {
    await updateSummary({ ciStatus: 'failing_required' });
    expect(await reconcileMobileNotificationEvents(database.db)).toBe(1);
    const input = vi.mocked(enqueueMobileNotification).mock.calls[0][0];
    expect(isMobileNotificationPayload({ schemaVersion: 1, eventId: input.eventId, category: input.category, destination: input.destination })).toBe(true);
    expect(input.destination).toEqual(prDestination);
    expect(await reconcileMobileNotificationEvents(database.db)).toBe(0);
    expect(enqueueMobileNotification).toHaveBeenCalledTimes(1);
  });

  it('retains the journal after a crash during outbox creation', async () => {
    await updateSummary({ ciStatus: 'failing_required' });
    vi.mocked(enqueueMobileNotification).mockRejectedValueOnce(new Error('interrupted'));
    await expect(reconcileMobileNotificationEvents(database.db)).rejects.toThrow('interrupted');
    expect(await events()).toHaveLength(1);
    await reconcileMobileNotificationEvents(database.db);
    expect(await events()).toHaveLength(0);
  });

  it('claims each journal event once across concurrent sweeps', async () => {
    await updateSummary({ ciStatus: 'failing_required' });
    const results = await Promise.all([reconcileMobileNotificationEvents(database.db), reconcileMobileNotificationEvents(database.db)]);
    expect(results.reduce((total, value) => total + value, 0)).toBe(1);
    expect(enqueueMobileNotification).toHaveBeenCalledTimes(1);
  });

  it('bounds one reconciliation batch to 100 events', async () => {
    await database.db.update(workbenchChats).set({ status: 'idle' }).where(eq(workbenchChats.id, chat));
    const [template] = await events();
    await database.db.insert(mobileNotificationSourceEvents).values(Array.from({ length: 100 }, (_, index) => ({
      ...template, id: `bounded-${index}`, deduplicationKey: `bounded-${index}`,
    })));
    expect(await reconcileMobileNotificationEvents(database.db)).toBe(100);
    expect(await events()).toHaveLength(1);
    expect(await reconcileMobileNotificationEvents(database.db)).toBe(1);
  });

  it.each(['resolved', 'deleted', 'expired'])('drops a %s event before outbox creation', async (condition) => {
    await updateSummary({ ciStatus: 'failing_required' });
    if (condition === 'resolved') await updateSummary({ ciStatus: 'passing' });
    if (condition === 'deleted') await database.db.delete(pullRequests).where(eq(pullRequests.id, pr));
    if (condition === 'expired') await database.db.update(mobileNotificationSourceEvents).set({ createdAt: new Date(0) });
    await reconcileMobileNotificationEvents(database.db);
    expect(enqueueMobileNotification).not.toHaveBeenCalled();
    expect(await events()).toHaveLength(0);
  });

  it('removes journal rows when the owner is deleted', async () => {
    await updateSummary({ ciStatus: 'failing_required' });
    await database.pglite.query('DELETE FROM users WHERE id = $1', [owner]);
    expect(await events()).toHaveLength(0);
  });

  it('blocks Data API roles and permits scoped old binaries to update state', async () => {
    for (const role of ['anon', 'authenticated', 'service_role', 'talyn_backend']) {
      const result = await database.pglite.query<{ allowed: boolean }>('SELECT has_table_privilege($1,$2,$3) AS allowed', [role, 'mobile_notification_source_events', 'SELECT']);
      expect(result.rows[0].allowed).toBe(false);
      const functions = await database.pglite.query<{ allowed: boolean }>(
        `SELECT has_function_privilege($1,p.oid,'EXECUTE') AS allowed FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
         ('mobile_record_notification','mobile_chat_notification_transition','mobile_session_notification_transition','mobile_pr_notification_transition','mobile_merge_queue_notification_transition')`, [role]);
      expect(functions.rows).toHaveLength(5);
      expect(functions.rows.every((row) => !row.allowed)).toBe(true);
    }
    await database.pglite.exec(`BEGIN; SET LOCAL ROLE talyn_backend; SET LOCAL "request.jwt.claim.sub" = '${owner}'; UPDATE workbench_chats SET status = 'idle' WHERE id = '${chat}'; COMMIT;`);
    expect(await events()).toHaveLength(1);
  });

  it('rechecks workspace and entity kind for authoritative destinations', async () => {
    expect(await notificationStillActionable('session_update', { kind: 'thread', workspaceId: workspace, entityId: session }, database.db)).toBe(false);
    expect(await notificationStillActionable('session_update', { kind: 'session', workspaceId: owner, entityId: session }, database.db)).toBe(false);
  });

  it.each(['closed_chat', 'archived_session'])('suppresses a gate after %s', async (condition) => {
    await database.db.update(workbenchChats).set({ status: 'awaiting_input' }).where(eq(workbenchChats.id, chat));
    if (condition === 'closed_chat') await database.db.update(workbenchChats).set({ closedAt: new Date() }).where(eq(workbenchChats.id, chat));
    else await database.db.update(workbenches).set({ archivedAt: new Date() }).where(eq(workbenches.id, session));
    await reconcileMobileNotificationEvents(database.db);
    expect(enqueueMobileNotification).not.toHaveBeenCalled();
  });

  it.each([null, [], 'invalid'])('suppresses a malformed authoritative summary: %s', async (summary) => {
    await updateSummary({ ciStatus: 'failing_required' });
    await database.pglite.query('UPDATE pull_requests SET last_summary=$1::jsonb WHERE id=$2', [JSON.stringify(summary), pr]);
    await reconcileMobileNotificationEvents(database.db);
    expect(enqueueMobileNotification).not.toHaveBeenCalled();
  });

  it.each(['agent_needs_human', 'code_review_blocker'])('records a separate queue gate: %s', async (blockedCode) => {
    await database.db.insert(mergeQueueEntries).values({ id: 'queue-entry', pullRequestId: pr, workspaceId: workspace,
      repositoryId: repository, status: 'blocked', blockedCode, blockedReason: 'Private gate details', headSha: 'head-a' });
    await database.db.update(mergeQueueEntries).set({ status: 'blocked', blockedCode, blockedReason: 'Private gate details', lastEvaluatedAt: new Date() });
    expect((await events()).map((row) => row.category)).toEqual(['human_gate']);
    expect(JSON.stringify(await events())).not.toContain('Private gate details');
    expect(await notificationStillActionable('human_gate', prDestination, database.db)).toBe(true);
    await database.db.update(mergeQueueEntries).set({ blockedReason: 'Changed private gate details' });
    expect(await events()).toHaveLength(2);
    await reconcileMobileNotificationEvents(database.db);
    expect(enqueueMobileNotification).toHaveBeenCalledTimes(2);
  });

  it.each(['queued', 'removed', 'merged'])('suppresses a queue gate that becomes %s', async (status) => {
    await database.db.insert(mergeQueueEntries).values({ id: 'queue-entry', pullRequestId: pr, workspaceId: workspace,
      repositoryId: repository, status: 'blocked', blockedCode: 'agent_needs_human' });
    await database.db.update(mergeQueueEntries).set({ status });
    await reconcileMobileNotificationEvents(database.db);
    expect(enqueueMobileNotification).not.toHaveBeenCalled();
  });

  it('suppresses queue gates when their PR closes', async () => {
    await database.db.insert(mergeQueueEntries).values({ id: 'queue-entry', pullRequestId: pr, workspaceId: workspace,
      repositoryId: repository, status: 'blocked', blockedCode: 'agent_needs_human' });
    await database.db.update(pullRequests).set({ state: 'closed' }).where(eq(pullRequests.id, pr));
    await reconcileMobileNotificationEvents(database.db);
    expect(enqueueMobileNotification).not.toHaveBeenCalled();
  });

  it('does not duplicate PR check gates from the queue', async () => {
    await updateSummary({ humanGates: [{ id: 'check-gate' }] });
    await database.db.insert(mergeQueueEntries).values({ id: 'queue-entry', pullRequestId: pr, workspaceId: workspace,
      repositoryId: repository, status: 'blocked', blockedCode: 'awaiting_human_check' });
    expect(await events()).toHaveLength(1);
  });

  it('does not record a queue block without a human gate code', async () => {
    await database.db.insert(mergeQueueEntries).values({ id: 'queue-entry', pullRequestId: pr, workspaceId: workspace,
      repositoryId: repository, status: 'blocked', blockedCode: null });
    expect(await events()).toHaveLength(0);
  });
});
