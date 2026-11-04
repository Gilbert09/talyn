import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  usageInsightsBackfill,
  workbenchBootSamples,
  workbenchChats,
  workbenchEvents,
  workbenchTurnUsage,
  workspaces,
} from '../db/schema.js';
import { insertChat, insertWorkbench, recordBootMetric } from '../services/workbenches/store.js';
import { recordTurnUsage, scheduleTurnUsage, settleTurnUsageForTests } from '../services/insights/turnUsage.js';
import {
  backfillBatch,
  backfillUsageInsights,
  inBackfillWindow,
  USAGE_INSIGHTS_BACKFILL,
} from '../services/insights/backfill.js';

const T0 = new Date('2026-11-01T10:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

describe('Insights writers', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    await seedUser(db, { id: 'owner' });
    await db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'W' });
    await insertWorkbench({ id: 'wb', workspaceId: 'ws', repoFullName: 'o/r', baseBranch: 'main', branch: 'b', name: 'n', runtime: 'sandbox', status: 'ready', agent: 'claude', model: 'wb-model' });
    await insertWorkbench({ id: 'wb-codex', workspaceId: 'ws', repoFullName: 'o/r', baseBranch: 'main', branch: 'c', name: 'c', runtime: 'sandbox', status: 'ready', agent: 'codex' });
    await insertChat({ id: 'chat-claude', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    await insertChat({ id: 'chat-codex', workbenchId: 'wb-codex', workspaceId: 'ws', title: 'Chat', agent: 'codex', model: 'gpt-codex' });
  });

  afterEach(async () => {
    await cleanup();
  });

  let seq = 0;
  const event = (chatId: string, turn: number, s: number, body: Record<string, unknown>) =>
    db.insert(workbenchEvents).values({ chatId, seq: ++seq, turn, event: body, createdAt: at(s) });

  async function claudeTurn(turn: number, base: number, modelUsage: Record<string, unknown>) {
    await event('chat-claude', turn, base, { type: 'user', message: { content: 'hi' }, talyn: { kind: 'user_message', sentAt: at(base).toISOString() } });
    await event('chat-claude', turn, base + 1, { type: 'system', subtype: 'init', model: 'claude-main' });
    await event('chat-claude', turn, base + 3, { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } });
    await event('chat-claude', turn, base + 9, {
      type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.3, duration_ms: 8000, num_turns: 3,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage,
    });
  }

  async function codexTurn(turn: number, base: number, usage: Record<string, number>, sessionId = 'thread-1') {
    await event('chat-codex', turn, base, { type: 'user', talyn: { kind: 'user_message', sentAt: at(base).toISOString() } });
    await event('chat-codex', turn, base + 2, { type: 'assistant', session_id: sessionId, message: { content: [] } });
    await event('chat-codex', turn, base + 5, { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, usage });
  }

  const usageRows = () => db.select().from(workbenchTurnUsage).orderBy(asc(workbenchTurnUsage.chatId), asc(workbenchTurnUsage.turn), asc(workbenchTurnUsage.model));

  it('records a Claude turn per model, with the reply time and the cost estimate', async () => {
    await claudeTurn(1, 0, {
      'claude-main': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 0.29 },
      'claude-haiku': { inputTokens: 5, outputTokens: 5, costUSD: 0.01 },
    });
    const rows = await recordTurnUsage('chat-claude', 1);
    expect(rows).toHaveLength(2);
    const stored = await usageRows();
    expect(stored.map((r) => [r.model, r.isPrimary, r.costEstimateMicros])).toEqual([
      ['claude-haiku', false, 10_000],
      ['claude-main', true, 290_000],
    ]);
    expect(stored.find((r) => r.isPrimary)).toMatchObject({
      workspaceId: 'ws', workbenchId: 'wb', agent: 'claude', inputTokens: 10, outputTokens: 20,
      cacheReadTokens: 300, cacheWriteTokens: 40, durationMs: 8000, agentSteps: 3, firstReplyMs: 3000, isError: false,
    });
    expect(stored[0].endedAt.toISOString()).toBe(at(9).toISOString());
  });

  it('a re-record replaces the turn and drops a model it no longer has', async () => {
    await claudeTurn(1, 0, { a: { inputTokens: 1 }, b: { inputTokens: 2 } });
    await recordTurnUsage('chat-claude', 1);
    await db.delete(workbenchEvents).where(eq(workbenchEvents.chatId, 'chat-claude'));
    await claudeTurn(1, 0, { a: { inputTokens: 7 } });
    await recordTurnUsage('chat-claude', 1);
    expect((await usageRows()).map((r) => [r.model, r.inputTokens])).toEqual([['a', 7]]);
  });

  it('stores Codex turns as differences of the thread totals', async () => {
    await codexTurn(1, 0, { input_tokens: 21_905, cache_read_input_tokens: 8064, output_tokens: 5 });
    await codexTurn(2, 100, { input_tokens: 43_828, cache_read_input_tokens: 29_824, output_tokens: 22 });
    await recordTurnUsage('chat-codex', 1);
    await recordTurnUsage('chat-codex', 2);
    expect((await usageRows()).map((r) => [r.turn, r.model, r.inputTokens, r.cacheReadTokens, r.outputTokens, r.costEstimateMicros, r.firstReplyMs])).toEqual([
      [1, 'gpt-codex', 13_841, 8064, 5, null, 2000],
      [2, 'gpt-codex', 163, 21_760, 17, null, 2000],
    ]);
  });

  it('records nothing for a turn without a result, or an unknown chat', async () => {
    await event('chat-claude', 1, 0, { type: 'user', talyn: { kind: 'user_message', sentAt: T0.toISOString() } });
    expect(await recordTurnUsage('chat-claude', 1)).toEqual([]);
    expect(await recordTurnUsage('nope', 1)).toEqual([]);
    expect(await usageRows()).toEqual([]);
  });

  it('scheduleTurnUsage runs in the background and never throws', async () => {
    await claudeTurn(1, 0, { m: { inputTokens: 3 } });
    scheduleTurnUsage('chat-claude', 1);
    scheduleTurnUsage('missing-chat', 4);
    await settleTurnUsageForTests();
    expect((await usageRows()).map((r) => r.model)).toEqual(['m']);
  });

  it('recordBootMetric mirrors box starts and successful wakes into the samples table', async () => {
    await recordBootMetric('wb', 'box_created', { sandboxId: 'sb', cause: 'new', layer: 'user', totalMs: 41_000 });
    await recordBootMetric('wb', 'wake_end', { at: T0.toISOString(), from: 'host', ms: 800, ok: true });
    await recordBootMetric('wb', 'wake_end', { at: T0.toISOString(), from: 'storage', ms: 9000, ok: false });
    await recordBootMetric('wb', 'capacity_wait_start', { why: 'x' });
    const samples = await db.select().from(workbenchBootSamples).orderBy(asc(workbenchBootSamples.seq));
    expect(samples.map((s) => [s.kind, s.ms, s.cause, s.layer, s.source, s.workspaceId, s.workbenchId, s.chatId])).toEqual([
      ['box_start', 41_000, 'new', 'user', null, 'ws', 'wb', 'chat-claude'],
      ['wake', 800, null, null, 'host', 'ws', 'wb', 'chat-claude'],
    ]);
  });

  describe('backfill', () => {
    beforeEach(async () => {
      await claudeTurn(1, 0, { 'claude-main': { inputTokens: 10, costUSD: 0.1 } });
      await claudeTurn(2, 50, { 'claude-main': { inputTokens: 20, costUSD: 0.2 } });
      await codexTurn(1, 0, { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 });
      await codexTurn(2, 100, { input_tokens: 250, cache_read_input_tokens: 50, output_tokens: 30 });
      await event('chat-claude', 2, 70, { type: 'system', subtype: 'boot_metric', metric: 'box_created', totalMs: 5000, cause: 'move', layer: 'repo' });
      await event('chat-claude', 2, 71, { type: 'system', subtype: 'boot_metric', metric: 'wake_end', ms: 1200, ok: true, from: 'storage' });
      await event('chat-claude', 2, 72, { type: 'system', subtype: 'boot_metric', metric: 'wake_end', ms: 1200, ok: false, from: 'host' });
    });

    const state = async () => (await db.select().from(usageInsightsBackfill).where(eq(usageInsightsBackfill.name, USAGE_INSIGHTS_BACKFILL)))[0];

    it('walks chats in batches, carries the Codex baseline, and stops when done', async () => {
      expect(await backfillBatch(1)).toMatchObject({ chats: 1, turnRows: 2, bootSamples: 2, completed: false });
      expect(await state()).toMatchObject({ cursor: 'chat-claude', chatsDone: 1, completedAt: null });
      expect(await backfillBatch(1)).toMatchObject({ chats: 1, turnRows: 2, completed: false });
      expect(await backfillBatch(1)).toMatchObject({ chats: 0, completed: true });
      expect((await state())?.completedAt).toBeInstanceOf(Date);
      expect(await backfillBatch(1)).toEqual({ chats: 0, turnRows: 0, bootSamples: 0, completed: true });

      const rows = await usageRows();
      expect(rows.map((r) => [r.chatId, r.turn, r.inputTokens, r.cacheReadTokens, r.outputTokens, r.costEstimateMicros])).toEqual([
        ['chat-claude', 1, 10, 0, 0, 100_000],
        ['chat-claude', 2, 20, 0, 0, 200_000],
        ['chat-codex', 1, 100, 0, 10, null],
        ['chat-codex', 2, 100, 50, 20, null],
      ]);
      const samples = await db.select().from(workbenchBootSamples).orderBy(asc(workbenchBootSamples.seq));
      expect(samples.map((s) => [s.kind, s.ms, s.cause, s.source])).toEqual([
        ['box_start', 5000, 'move', null],
        ['wake', 1200, null, 'storage'],
      ]);
    });

    it('skips chats with no activity in the last 30 days', async () => {
      const now = new Date();
      await db.update(workbenchChats).set({ updatedAt: new Date(now.getTime() - 31 * 86_400_000) }).where(eq(workbenchChats.id, 'chat-codex'));
      await db.update(workbenchChats).set({ updatedAt: new Date(now.getTime() - 29 * 86_400_000) }).where(eq(workbenchChats.id, 'chat-claude'));
      expect(await backfillBatch(10, now)).toMatchObject({ chats: 1, turnRows: 2, completed: true });
      expect([...new Set((await usageRows()).map((r) => r.chatId))]).toEqual(['chat-claude']);
    });

    it.each<[string, string, boolean]>([
      ['before the window', '2026-11-05T00:59:59Z', false],
      ['at the window start', '2026-11-05T01:00:00Z', true],
      ['inside the window', '2026-11-05T05:59:59Z', true],
      ['at the window end', '2026-11-05T06:00:00Z', false],
      ['midday', '2026-11-05T12:00:00Z', false],
    ])('runs only in the night window: %s', async (_label, iso, runs) => {
      const now = new Date(iso);
      // Chats active in the 30 days before that night.
      await db.update(workbenchChats).set({ updatedAt: new Date(now.getTime() - 86_400_000) });
      expect(inBackfillWindow(now)).toBe(runs);
      expect(await backfillUsageInsights(now)).toBe(runs);
      expect((await usageRows()).length).toBe(runs ? 4 : 0);
      expect((await state())?.cursor ?? null).toBe(runs ? 'chat-codex' : null);
    });

    it('resumes from its cursor on the next night', async () => {
      const night = new Date('2026-11-05T05:59:00Z');
      await db.update(workbenchChats).set({ updatedAt: new Date(night.getTime() - 86_400_000) });
      expect(await backfillBatch(1, night)).toMatchObject({ chats: 1, completed: false });
      expect(await backfillUsageInsights(new Date('2026-11-05T09:00:00Z'))).toBe(false);
      expect(await state()).toMatchObject({ cursor: 'chat-claude', completedAt: null });
      expect(await backfillBatch(1, new Date('2026-11-06T01:00:00Z'))).toMatchObject({ chats: 1, completed: false });
      expect(await state()).toMatchObject({ cursor: 'chat-codex', chatsDone: 2 });
    });

    it('is safe to re-run and keeps rows the live writer already stored', async () => {
      await recordTurnUsage('chat-claude', 1);
      await db.update(workbenchTurnUsage).set({ inputTokens: 999 }).where(eq(workbenchTurnUsage.turn, 1));
      // Three new rows: the live writer already stored the fourth.
      expect(await backfillBatch(10)).toMatchObject({ chats: 2, turnRows: 3, bootSamples: 2, completed: true });
      await db.delete(usageInsightsBackfill);
      expect(await backfillBatch(10)).toMatchObject({ chats: 2, turnRows: 0, bootSamples: 0, completed: true });
      const rows = await usageRows();
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.chatId === 'chat-claude' && r.turn === 1)?.inputTokens).toBe(999);
    });
  });
});
