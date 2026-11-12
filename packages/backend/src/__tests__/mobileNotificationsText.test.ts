import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { pullRequestOutcomeEvent, type MobileNotificationCategory } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { mergeQueueEntries, pullRequests, repositories, workbenchChats, workbenchEvents, workbenches, workspaces } from '../db/schema.js';
import type { Database } from '../db/client.js';
import {
  composeMobilePushText, PUSH_BODY_MAX, PUSH_EVENT_LIMIT, PUSH_TITLE_MAX, pushEventsQuery, pushPullRequestQuery,
} from '../services/mobileNotifications/text.js';
import { genericPushText } from '../services/mobileNotifications/provider.js';

const owner = '00000000-0000-4000-8000-000000000001';
const workspace = '00000000-0000-4000-8000-000000000002';
const session = '00000000-0000-4000-8000-000000000003';
const repository = '00000000-0000-4000-8000-000000000004';
const chat = '00000000-0000-4000-8000-000000000005';
const pr = '00000000-0000-4000-8000-000000000006';
const sessionDestination = { kind: 'session' as const, workspaceId: workspace, entityId: session };
const prDestination = { kind: 'pull_request' as const, workspaceId: workspace, entityId: pr };
const baseline = { title: 'Fix the login flow', headSha: 'head-a', humanGates: [], reviewDecision: null };

const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const question = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [
  { type: 'text', text: 'Before I go on:' },
  { type: 'tool_use', id: 'tool1', name: 'AskUserQuestion', input: { questions: [{ question: text, options: [] }] } },
] } });
const toolResult = (output: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: output }] } });

describe('mobile push text', () => {
  let database: Awaited<ReturnType<typeof createTestDb>>;
  let db: Database;
  beforeAll(async () => { database = await createTestDb(); db = database.db as unknown as Database; }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    await database.pglite.exec('DELETE FROM users');
    await seedUser(database.db, { id: owner });
    await database.db.insert(workspaces).values({ id: workspace, ownerId: owner, name: 'Workspace' });
    await database.db.insert(repositories).values({ id: repository, workspaceId: workspace, name: 'Repository', url: 'https://example.test/repository' });
    await database.db.insert(workbenches).values({ id: session, workspaceId: workspace, repositoryId: repository, name: 'internal-branch',
      title: 'Fix session settings', repoFullName: 'fixture/repository', branch: 'branch', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready' });
    await database.db.insert(workbenchChats).values({ id: chat, workspaceId: workspace, workbenchId: session, title: 'Chat', agent: 'claude', status: 'running' });
    await database.db.insert(pullRequests).values({ id: pr, workspaceId: workspace, repositoryId: repository,
      owner: 'fixture', repo: 'repository', number: 42, state: 'open', authored: true, lastSummary: baseline });
  });

  let seq = 0;
  const addEvents = async (chatId: string, turn: number, events: Record<string, unknown>[]) => {
    if (!events.length) return;
    await database.db.insert(workbenchEvents).values(events.map((event) => ({ chatId, seq: ++seq, turn, event: { ...event, seq } })));
  };
  const setChat = (values: Partial<typeof workbenchChats.$inferInsert>) =>
    database.db.update(workbenchChats).set({ ...values, updatedAt: new Date() }).where(eq(workbenchChats.id, chat));
  const setSummary = (patch: Record<string, unknown>) =>
    database.db.update(pullRequests).set({ lastSummary: { ...baseline, ...patch } }).where(eq(pullRequests.id, pr));
  const compose = (category: MobileNotificationCategory, destination: typeof sessionDestination | typeof prDestination = sessionDestination) =>
    composeMobilePushText(category, destination, db);

  describe('sessions', () => {
    it('summarises a finished turn with the session name', async () => {
      await addEvents(chat, 1, [assistant('Earlier turn text.')]);
      await addEvents(chat, 2, [assistant('Updated the settings page. Tests now pass.'), toolResult('x'.repeat(10_000))]);
      await setChat({ status: 'idle' });
      expect(await compose('session_update')).toEqual({ title: 'Done: Fix session settings', body: 'Updated the settings page.' });
    });

    it('reports a pull request the turn opened', async () => {
      await addEvents(chat, 1, [assistant('Opened it.'), pullRequestOutcomeEvent({ ok: true, number: 7, url: 'u', existing: false })]);
      await setChat({ status: 'idle' });
      expect(await compose('session_update')).toEqual({ title: 'Done: Fix session settings', body: 'Opened PR #7' });
    });

    it('asks the AskUserQuestion question for human_gate', async () => {
      await addEvents(chat, 1, [question('Which database should I use?')]);
      await setChat({ status: 'awaiting_input' });
      expect(await compose('human_gate')).toEqual({ title: 'Needs your reply: Fix session settings', body: 'Which database should I use?' });
    });

    it.each([
      ['the result error', [{ type: 'result', is_error: true, result: 'The build failed.' }], null, 'The build failed.'],
      ['the chat error', [], 'The sandbox stopped.', 'The sandbox stopped.'],
      ['the fallback', [], null, 'The agent stopped with an error.'],
    ] as const)('uses %s for a failed chat', async (_name, events, statusMessage, body) => {
      await addEvents(chat, 1, [...events]);
      await setChat({ status: 'error', statusMessage });
      expect(await compose('session_update')).toEqual({ title: 'Failed: Fix session settings', body });
    });

    it('ignores nested assistant text and keeps only the latest turn', async () => {
      await addEvents(chat, 1, [pullRequestOutcomeEvent({ ok: true, number: 10, url: 'u', existing: false })]);
      await addEvents(chat, 2, [assistant('Updated the settings page.'), assistant('Nested task finished.', { parent_tool_use_id: 'tool1' })]);
      await setChat({ status: 'idle' });
      expect((await compose('session_update')).body).toBe('Updated the settings page.');
    });

    it('picks the chat that changed most recently', async () => {
      const other = '00000000-0000-4000-8000-000000000007';
      await database.db.insert(workbenchChats).values({ id: other, workspaceId: workspace, workbenchId: session, title: 'Old', agent: 'claude',
        status: 'idle', updatedAt: new Date(Date.now() - 60_000) });
      await addEvents(other, 1, [assistant('Old chat text.')]);
      await addEvents(chat, 1, [assistant('New chat text.')]);
      await setChat({ status: 'idle' });
      expect((await compose('session_update')).body).toBe('New chat text.');
    });

    it.each([
      ['error', 'Could not create the sandbox.', 'Could not create the sandbox.'],
      ['archiveError', null, 'The agent stopped with an error.'],
    ] as const)('reports a workbench-level %s', async (status, statusMessage, body) => {
      await database.db.update(workbenches).set({ status, statusMessage }).where(eq(workbenches.id, session));
      expect(await compose('session_update')).toEqual({ title: 'Failed: Fix session settings', body });
    });

    it('uses the session fallbacks when no chat matches', async () => {
      await database.db.update(workbenches).set({ title: null }).where(eq(workbenches.id, session));
      expect(await compose('session_update')).toEqual({ title: 'Done: internal-branch', body: 'The agent finished.' });
      expect(await compose('human_gate')).toEqual({ title: 'Needs your reply: internal-branch', body: 'The agent is waiting for your answer.' });
    });

    it('cuts a long title to the push limit', async () => {
      await database.db.update(workbenches).set({ title: 'x'.repeat(200) }).where(eq(workbenches.id, session));
      const { title } = await compose('session_update');
      expect(title).toHaveLength(PUSH_TITLE_MAX);
      expect(title).toMatch(/…$/);
    });

    it.each([
      ['a missing session', { ...sessionDestination, entityId: '00000000-0000-4000-8000-000000000099' }],
      ['another workspace', { ...sessionDestination, workspaceId: '00000000-0000-4000-8000-000000000099' }],
      ['the wrong kind', { ...sessionDestination, kind: 'thread' as const }],
    ])('falls back to generic text for %s', async (_name, destination) => {
      expect(await composeMobilePushText('session_update', destination, db)).toEqual(genericPushText('session_update'));
    });
  });

  describe('pull requests', () => {
    it.each([
      ['a review request', { reviewRequested: true }, {}, 'Review requested'],
      ['an approval', {}, { reviewDecision: 'APPROVED' }, 'Approved'],
      ['requested changes', {}, { reviewDecision: 'CHANGES_REQUESTED' }, 'Changes requested'],
    ])('names %s', async (_name, columns, summary, title) => {
      if (Object.keys(columns).length) await database.db.update(pullRequests).set(columns).where(eq(pullRequests.id, pr));
      await setSummary(summary);
      expect(await compose('pr_review', prDestination)).toEqual({ title, body: 'fixture/repository#42 Fix the login flow' });
    });

    it.each([
      ['ci_failure', 'Checks failed'],
      ['merge_ready', 'Ready to merge'],
    ] as const)('names %s with the PR reference and title', async (category, title) => {
      expect(await compose(category, prDestination)).toEqual({ title, body: 'fixture/repository#42 Fix the login flow' });
    });

    it('uses only the reference when the summary has no title', async () => {
      await database.db.update(pullRequests).set({ lastSummary: {} }).where(eq(pullRequests.id, pr));
      expect(await compose('ci_failure', prDestination)).toEqual({ title: 'Checks failed', body: 'fixture/repository#42' });
    });

    it.each([
      ['its reason', 'agent_needs_human', 'A maintainer must approve the deploy.', "fixture/repository#42 can't merge — A maintainer must approve the deploy. Needs manual intervention."],
      ['the code fallback', 'code_review_blocker', null, "fixture/repository#42 can't merge — the code review found a blocker. Needs manual intervention."],
    ])('mirrors the desktop merge queue alert with %s', async (_name, blockedCode, blockedReason, body) => {
      await database.db.insert(mergeQueueEntries).values({ id: 'queue-entry', pullRequestId: pr, workspaceId: workspace,
        repositoryId: repository, status: 'blocked', blockedCode, blockedReason, headSha: 'head-a' });
      expect(await compose('human_gate', prDestination)).toEqual({ title: 'Merge queue blocked', body });
    });

    it('ignores a queue entry that is not a human block', async () => {
      await database.db.insert(mergeQueueEntries).values({ id: 'queue-entry', pullRequestId: pr, workspaceId: workspace,
        repositoryId: repository, status: 'blocked', blockedCode: 'checks_failed', blockedReason: 'Red', headSha: 'head-a' });
      await setSummary({ humanGates: [{ id: 'vr', label: 'Visual review', name: 'visual-review', url: null }] });
      expect(await compose('human_gate', prDestination)).toEqual({ title: 'A PR needs you', body: 'fixture/repository#42 needs you — Visual review' });
    });

    it('names the PR when no gate is known', async () => {
      expect(await compose('human_gate', prDestination)).toEqual({ title: 'A PR needs you', body: 'fixture/repository#42 Fix the login flow' });
    });

    it('cuts a long body to the push limit', async () => {
      await setSummary({ title: 'y'.repeat(400) });
      const { body } = await compose('merge_ready', prDestination);
      expect(body).toHaveLength(PUSH_BODY_MAX);
      expect(body).toMatch(/^fixture\/repository#42 y+…$/);
    });

    it.each(['pr_review', 'ci_failure', 'merge_ready', 'human_gate'] as const)('falls back to generic %s text for a missing PR', async (category) => {
      await database.db.delete(pullRequests).where(eq(pullRequests.id, pr));
      expect(await compose(category, prDestination)).toEqual(genericPushText(category));
    });
  });

  it('falls back to generic text when a lookup throws', async () => {
    const broken = { select: () => { throw new Error('database down'); } } as unknown as Database;
    expect(await composeMobilePushText('ci_failure', prDestination, broken)).toEqual(genericPushText('ci_failure'));
    expect(await composeMobilePushText('human_gate', sessionDestination, broken)).toEqual(genericPushText('human_gate'));
  });

  describe('egress', () => {
    it('reads single keys of last_summary, never the whole column', () => {
      const query = pushPullRequestQuery(db, prDestination).toSQL().sql;
      expect(query).toContain(`"last_summary" ->> 'title'`);
      expect(query).not.toMatch(/"last_summary"(?!\s*->)/);
      expect(query).not.toContain('"body"');
      expect(query).toMatch(/limit \$\d+$/i);
    });

    it('bounds the events query to one chat, newest first, and drops tool output', () => {
      const built = pushEventsQuery(db, chat).toSQL();
      expect(built.sql).toMatch(/where "workbench_events"."chat_id" = \$\d+/i);
      expect(built.sql).toMatch(/order by "workbench_events"."seq" desc limit \$\d+$/i);
      expect(built.params).toContain(PUSH_EVENT_LIMIT);
      expect(built.params).toContain(chat);
    });

    it('returns no tool output from the database', async () => {
      await addEvents(chat, 1, [assistant('Done.'), toolResult('secret tool output')]);
      const rows = await pushEventsQuery(db, chat);
      expect(JSON.stringify(rows)).not.toContain('secret tool output');
      expect(rows.find((row) => row.event?.type === 'assistant')?.event).toEqual({
        type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }] },
      });
    });
  });
});
