import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AgentEvent, TaskResult } from '@talyn/shared';
import { finalAssistantTailQuery, selfHostedPoller } from '../services/selfHosted/poller.js';
import type { FleetSandbox } from '../services/selfHosted/client.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';

vi.mock('../services/selfHosted/credentials.js', () => ({
  getSelfHostedClient: vi.fn(),
  getSelfHostedCredentials: vi.fn(),
}));

const WS = 'ws-1';
const PR_URL = 'https://github.com/example/repo/pull/1';
const REASON = 'A maintainer must approve the check.';
const SENTINEL = `TALYN_NEEDS_HUMAN: ${REASON}`;

type PollerInternals = {
  finalize: (taskId: string, workspaceId: string, sandbox: FleetSandbox, prUrl: string | null) => Promise<void>;
  captureOutcome: () => Promise<void>;
  transcripts: Map<string, AgentEvent[]>;
};

const poller = selfHostedPoller as unknown as PollerInternals;

function assistant(seq: number, text: string): AgentEvent {
  return { seq, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function result(seq: number, text: string): AgentEvent {
  return { seq, type: 'result', result: text, subtype: 'completed', is_error: false };
}

function sandbox(): FleetSandbox {
  return {
    id: 'sandbox-1',
    workspaceId: WS,
    status: 'stopped',
    tasks: [{ taskId: 'fleet-task-1', status: 'completed', prUrl: PR_URL }],
  };
}

async function seedTask(db: Database, id: string, transcript: AgentEvent[] | null): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    workspaceId: WS,
    type: 'code_writing',
    status: 'in_progress',
    title: 'Fix the PR',
    description: 'Fix the PR',
    transcript,
  });
}

async function taskOutcome(db: Database, id: string) {
  const [row] = await db
    .select({ status: schema.tasks.status, result: schema.tasks.result })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id));
  return { status: row?.status, result: row?.result as TaskResult | null };
}

describe('self-hosted final assistant tail', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
    await seedUser(db);
    await db.insert(schema.workspaces).values({ id: WS, ownerId: 'user-test', name: 'WS' });
    vi.spyOn(poller, 'captureOutcome').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    poller.transcripts.clear();
    vi.restoreAllMocks();
    await cleanup();
  });

  it.each([
    {
      name: 'the last assistant message has the sentinel',
      events: [assistant(1, `I stopped.\n\n${SENTINEL}`), result(2, 'the harness completed')],
      needsHuman: true,
    },
    {
      name: 'only an older assistant message has the sentinel',
      events: [assistant(1, SENTINEL), assistant(2, 'The work is done.'), result(3, 'completed')],
      needsHuman: false,
    },
    {
      name: 'the sentinel is in a long transcript tail',
      events: [
        ...Array.from({ length: 58 }, (_, i) => ({ seq: i + 1, type: 'system' })),
        assistant(59, SENTINEL),
        result(60, 'completed'),
      ],
      needsHuman: true,
    },
    { name: 'the transcript is null', events: null, needsHuman: false },
    { name: 'the transcript is empty', events: [], needsHuman: false },
    {
      name: 'only the result event has the sentinel',
      events: [assistant(1, 'The work is done.'), result(2, SENTINEL)],
      needsHuman: false,
    },
  ])('settles correctly when $name', async ({ events, needsHuman }) => {
    const id = 'task-persisted-tail';
    await seedTask(db, id, events);

    await poller.finalize(id, WS, sandbox(), PR_URL);

    const outcome = await taskOutcome(db, id);
    expect(outcome.status).toBe(needsHuman ? 'needs_human' : 'completed');
    expect(outcome.result?.success).toBe(!needsHuman);
    expect(outcome.result?.summary).toBe(needsHuman ? REASON : `The fleet opened ${PR_URL}`);
    expect(outcome.result?.needsHuman).toEqual(needsHuman ? { reason: REASON } : undefined);
  });

  it('uses memory and skips the database read when live events exist', async () => {
    const id = 'task-live-tail';
    await seedTask(db, id, [assistant(1, 'The work is done.')]);
    poller.transcripts.set(id, [assistant(1, SENTINEL)]);
    const select = vi.spyOn(db, 'select');

    await poller.finalize(id, WS, sandbox(), PR_URL);

    expect(select).not.toHaveBeenCalled();
    expect(poller.transcripts.has(id)).toBe(false);
    select.mockRestore();
    expect((await taskOutcome(db, id)).status).toBe('needs_human');
  });

  it('keeps the sandbox outcome when the tail read fails', async () => {
    const id = 'task-tail-read-error';
    await seedTask(db, id, null);
    const select = vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await poller.finalize(id, WS, sandbox(), PR_URL);

    expect(error).toHaveBeenCalledWith(
      `[selfhosted] failed to read transcript tail for ${id.slice(0, 8)}:`,
      expect.any(Error),
    );
    select.mockRestore();
    expect((await taskOutcome(db, id)).status).toBe('completed');
  });

  it.each([
    ['null', null, null],
    ['empty', [], []],
    ['short', [assistant(1, 'done')], [assistant(1, 'done')]],
    [
      'long',
      Array.from({ length: 60 }, (_, i) => assistant(i + 1, `event ${i + 1}`)),
      Array.from({ length: 20 }, (_, i) => assistant(i + 41, `event ${i + 41}`)),
    ],
  ])('returns the correct SQL tail for %s transcripts', async (_name, events, expected) => {
    const id = 'task-sql-tail';
    await seedTask(db, id, events);

    const [row] = await finalAssistantTailQuery(id);

    expect(row?.events).toEqual(expected);
    expect(row?.events?.length ?? 0).toBeLessThanOrEqual(20);
  });

  it('selects only the sliced transcript expression', () => {
    const sql = finalAssistantTailQuery('task-id').toSQL().sql;
    const selected = sql.slice(0, sql.indexOf(' from '));
    expect(selected).toMatch(/^select jsonb_path_query_array\("transcript", \$1::jsonpath\)$/);
  });
});
