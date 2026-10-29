import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { workspaces, repositories } from '../db/schema.js';
import { appendEvents, insertChat, insertWorkbench, listEvents } from '../services/workbenches/store.js';
import { cleanJsonbString, stringifyJsonbSafe, toJsonbSafe } from '../services/workbenches/jsonSafe.js';

const F = '�';

describe('toJsonbSafe', () => {
  it.each([
    ['NUL in a string', 'a\u0000b', `a${F}b`],
    ['lone high surrogate', 'a\uD800b', `a${F}b`],
    ['lone low surrogate', 'a\uDC00b', `a${F}b`],
    ['high surrogate at the end', 'ab\uD83D', `ab${F}`],
    ['valid emoji pair', 'hi \u{1F600}!', 'hi \u{1F600}!'],
    ['reversed pair', '\uDE00\uD83D', `${F}${F}`],
    ['plain text', 'hello', 'hello'],
    ['empty string', '', ''],
  ])('cleans a string: %s', (_name, input, expected) => {
    expect(toJsonbSafe(input)).toBe(expected);
    expect(cleanJsonbString(input)).toBe(expected);
  });

  it('cleans object keys', () => {
    expect(toJsonbSafe({ 'k\u0000ey': 1, ok: 2 })).toEqual({ [`k${F}ey`]: 1, ok: 2 });
  });

  it('cleans nested arrays and objects and leaves other types alone', () => {
    const input = { a: [{ b: 'x\u0000', c: 3, d: null, e: true }, ['\uD800', 'fine']], n: 5 };
    expect(toJsonbSafe(input)).toEqual({ a: [{ b: `x${F}`, c: 3, d: null, e: true }, [F, 'fine']], n: 5 });
  });

  it('returns the same reference when nothing needs cleaning', () => {
    const input = { a: ['x', { b: '\u{1F600}' }], n: 1 };
    expect(toJsonbSafe(input)).toBe(input);
    expect(toJsonbSafe(input).a).toBe(input.a);
  });

  it('does not mutate its input', () => {
    const input = { a: 'x\u0000' };
    toJsonbSafe(input);
    expect(input.a).toBe('x\u0000');
  });

  it.each([
    ['clean', { a: 'b' }, '{"a":"b"}'],
    ['NUL', { a: 'x\u0000y' }, `{"a":"x${F}y"}`],
    ['surrogate', { a: '\uD800' }, `{"a":"${F}"}`],
    ['an escaped backslash-u text', { a: '\\u0000' }, '{"a":"\\\\u0000"}'],
  ])('stringifies for jsonb: %s', (_name, input, expected) => {
    expect(stringifyJsonbSafe(input)).toBe(expected);
  });
});

describe('appending events with characters jsonb rejects', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db.db, { id: 'owner' });
    await db.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Workspace' });
    await db.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
    await insertWorkbench({ id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', name: 'wb',
      branch: 'branch', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready', sandboxId: 'box', settings: {} });
    await insertChat({ id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude' });
  });
  afterEach(async () => { await db.cleanup(); });

  it.each([
    ['NUL', 'tool output\u0000 here'],
    ['lone high surrogate', 'cut emoji \uD83D'],
    ['lone low surrogate', '\uDE00 tail'],
  ])('stores an event containing %s', async (_name, text) => {
    const stored = await appendEvents('chat', [
      { turn: 1, event: { type: 'assistant', text, [`key${text.slice(0, 1)}\u0000`]: 1 } as never },
    ]);
    expect(stored).toHaveLength(1);
    const { events } = await listEvents('chat', 0, 10);
    expect(JSON.stringify(events[0].event)).not.toMatch(/\\u0000|\\ud[89a-f]/i);
    expect((events[0].event as { text: string }).text).toContain(F);
  });

  it('the raw insert is rejected, which is the failure the sanitizer prevents', async () => {
    const raw = JSON.stringify([{ turn: 1, event: { type: 'assistant', text: 'a\u0000b' } }]);
    await expect(db.db.execute(sql`
      INSERT INTO workbench_events (chat_id, seq, turn, event)
      SELECT 'chat', 99, (e.value ->> 'turn')::int, e.value -> 'event'
      FROM jsonb_array_elements(${raw}::jsonb) AS e(value)
    `)).rejects.toBeTruthy();
  });
});
