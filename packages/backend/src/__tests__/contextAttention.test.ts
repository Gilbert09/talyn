import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  attentionBadgeLabel,
  attentionReason,
  countContextAttention,
  sessionAttentionKey,
  sessionNeedsAttention,
  type AttentionSessionInput,
} from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  pullRequests as prTable,
  repositories as repositoriesTable,
  spaces as spacesTable,
  teams as teamsTable,
  workbenchChats as chatsTable,
  workbenchEvents as eventsTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { attentionChatsQuery, attentionSessionsQuery, contextAttention } from '../services/workbenches/attention.js';

const BASE: AttentionSessionInput = {
  kind: 'session',
  status: 'ready',
  sandboxState: 'running',
  archivedAt: null,
  chats: [{ status: 'idle', queued: 0 }],
  pr: null,
};

describe('sessionNeedsAttention', () => {
  it.each<[string, Partial<AttentionSessionInput>, boolean]>([
    ['an idle session', {}, false],
    ['a session that failed to start', { status: 'error' }, true],
    ['a session whose sandbox failed', { sandboxState: 'error' }, true],
    ['a chat that failed', { chats: [{ status: 'error', queued: 0 }] }, true],
    ['a failed chat next to a running one', { chats: [{ status: 'error', queued: 0 }, { status: 'running', queued: 0 }] }, true],
    ['a question for me', { chats: [{ status: 'awaiting_input', queued: 0 }] }, true],
    ['a question while another chat works', { chats: [{ status: 'awaiting_input', queued: 0 }, { status: 'running', queued: 0 }] }, false],
    ['a question with a queued message', { chats: [{ status: 'awaiting_input', queued: 1 }] }, false],
    ['a question while the box starts', { status: 'provisioning', chats: [{ status: 'awaiting_input', queued: 0 }] }, false],
    ['a question while the sandbox is created', { sandboxState: 'creating', chats: [{ status: 'awaiting_input', queued: 0 }] }, false],
    ['a running turn', { chats: [{ status: 'running', queued: 0 }] }, false],
    ['an open PR with conflicts', { pr: { state: 'open', mergeable: 'CONFLICTING' } }, true],
    ['an open mergeable PR', { pr: { state: 'open', mergeable: 'MERGEABLE' } }, false],
    ['an open PR not yet evaluated', { pr: { state: 'open', mergeable: null } }, false],
    ['a merged PR that once had conflicts', { pr: { state: 'merged', mergeable: 'CONFLICTING' } }, false],
    ['a conflicting PR while a turn runs', { pr: { state: 'open', mergeable: 'CONFLICTING' }, chats: [{ status: 'running', queued: 0 }] }, false],
    ['a thread with a conflicting PR', { kind: 'thread', pr: { state: 'open', mergeable: 'CONFLICTING' } }, false],
    ['a thread with a question', { kind: 'thread', chats: [{ status: 'awaiting_input', queued: 0 }] }, true],
    ['a plan that waits for approval', { chats: [{ status: 'idle', queued: 0, planPending: true }] }, true],
    ['a plan while another chat works', { chats: [{ status: 'idle', queued: 0, planPending: true }, { status: 'running', queued: 0 }] }, false],
    ['a plan with a queued message', { chats: [{ status: 'idle', queued: 1, planPending: true }] }, false],
    ['a plan flag on a running chat', { chats: [{ status: 'running', queued: 0, planPending: true }] }, false],
    ['a plan while the box starts', { status: 'provisioning', chats: [{ status: 'idle', queued: 0, planPending: true }] }, false],
    ['a thread with a plan', { kind: 'thread', chats: [{ status: 'idle', queued: 0, planPending: true }] }, true],
    ['an archived session with a plan', { archivedAt: new Date(), chats: [{ status: 'idle', queued: 0, planPending: true }] }, false],
    ['an archived session that failed', { archivedAt: new Date(), status: 'error' }, false],
    ['a session with archived status', { status: 'archived', chats: [{ status: 'awaiting_input', queued: 0 }] }, false],
    ['a session with no chats', { chats: [] }, false],
  ])('%s', (_label, patch, expected) => {
    expect(sessionNeedsAttention({ ...BASE, ...patch })).toBe(expected);
  });
});

describe('sessionAttentionKey', () => {
  const chat = (id: string, status: string, turnCount = 1, queued = 0) => ({ id, status, queued, turnCount });
  const plan = (id: string, turnCount = 1) => ({ ...chat(id, 'idle', turnCount), planPending: true });

  it.each<[string, Partial<AttentionSessionInput>, string | null]>([
    ['an idle session', { chats: [chat('c1', 'idle')] }, null],
    ['a session that failed to start', { status: 'error' }, 'error'],
    ['a session whose sandbox failed', { sandboxState: 'error' }, 'error'],
    ['a chat that failed', { chats: [chat('c1', 'error', 3)] }, 'chat_error:c1@3'],
    ['two failed chats, in a stable order', { chats: [chat('c2', 'error', 1), chat('c1', 'error', 4)] }, 'chat_error:c1@4,c2@1'],
    ['a question for me', { chats: [chat('c1', 'awaiting_input', 2)] }, 'reply:c1@2'],
    ['a question while another chat works', { chats: [chat('c1', 'awaiting_input'), chat('c2', 'running')] }, null],
    ['a plan for me', { chats: [plan('c1', 2)] }, 'plan:c1@2'],
    ['two plans, in a stable order', { chats: [plan('c2', 1), plan('c1', 3)] }, 'plan:c1@3,c2@1'],
    ['a question wins over a plan', { chats: [plan('c1'), chat('c2', 'awaiting_input', 2)] }, 'reply:c2@2'],
    ['a failure wins over a plan', { chats: [plan('c1'), chat('c2', 'error', 2)] }, 'chat_error:c2@2'],
    ['a plan wins over a conflicting PR', { chats: [plan('c1')], pr: { id: 'pr1', state: 'open', mergeable: 'CONFLICTING', headSha: 'abc' } }, 'plan:c1@1'],
    ['a conflicting PR', { pr: { id: 'pr1', state: 'open', mergeable: 'CONFLICTING', headSha: 'abc' } }, 'conflict:pr1:abc'],
    ['a conflicting PR with no head yet', { pr: { id: 'pr1', state: 'open', mergeable: 'CONFLICTING' } }, 'conflict:pr1:'],
    ['a mergeable PR', { pr: { id: 'pr1', state: 'open', mergeable: 'MERGEABLE', headSha: 'abc' } }, null],
    ['a chat with no id or turn count', { chats: [{ status: 'awaiting_input', queued: 0 }] }, 'reply:@0'],
    ['an archived session', { archivedAt: new Date(), status: 'error' }, null],
  ])('%s', (_label, patch, expected) => {
    expect(sessionAttentionKey({ ...BASE, ...patch })).toBe(expected);
  });

  it.each<[string, Partial<AttentionSessionInput>, Partial<AttentionSessionInput>]>([
    ['a question in a later turn', { chats: [chat('c1', 'awaiting_input', 1)] }, { chats: [chat('c1', 'awaiting_input', 2)] }],
    ['a question in another chat', { chats: [chat('c1', 'awaiting_input')] }, { chats: [chat('c2', 'awaiting_input')] }],
    ['a failure in a later turn', { chats: [chat('c1', 'error', 1)] }, { chats: [chat('c1', 'error', 2)] }],
    [
      'conflicts again after a push',
      { pr: { id: 'pr1', state: 'open', mergeable: 'CONFLICTING', headSha: 'a' } },
      { pr: { id: 'pr1', state: 'open', mergeable: 'CONFLICTING', headSha: 'b' } },
    ],
    ['a question after a failure', { chats: [chat('c1', 'error')] }, { chats: [chat('c1', 'awaiting_input')] }],
    ['a plan in a later turn', { chats: [plan('c1', 1)] }, { chats: [plan('c1', 2)] }],
    ['a question after a plan', { chats: [plan('c1', 1)] }, { chats: [chat('c1', 'awaiting_input', 1)] }],
  ])('names a new alert differently: %s', (_label, before, after) => {
    const a = sessionAttentionKey({ ...BASE, ...before });
    const b = sessionAttentionKey({ ...BASE, ...after });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe('countContextAttention', () => {
  it('adds space sessions to their workspace and space counts, and names each session', () => {
    expect(
      countContextAttention([
        { id: 'a', workspaceId: 'ws1', spaceId: null, reason: 'reply' },
        { id: 'b', workspaceId: 'ws1', spaceId: 'sp1', reason: 'failed' },
        { id: 'c', workspaceId: 'ws2', spaceId: 'sp1', reason: 'conflict' },
        { id: 'd', workspaceId: 'ws2', spaceId: 'sp2', reason: 'reply' },
      ]),
    ).toEqual({
      workspaces: { ws1: 2, ws2: 2 },
      spaces: { sp1: 2, sp2: 1 },
      workspaceSpaces: { ws1: { sp1: 1 }, ws2: { sp1: 1, sp2: 1 } },
      sessions: { a: 'reply', b: 'failed', c: 'conflict', d: 'reply' },
    });
  });

  it('answers empty maps for no sessions', () => {
    expect(countContextAttention([])).toEqual({ workspaces: {}, spaces: {}, workspaceSpaces: {}, sessions: {} });
  });
});

describe('attentionReason', () => {
  it.each<[string | null, string | null]>([
    [null, null],
    ['error', 'failed'],
    ['chat_error:c1@3', 'failed'],
    ['chat_error:c1@4,c2@1', 'failed'],
    ['reply:c1@2', 'reply'],
    ['reply:@0', 'reply'],
    ['plan:c1@2', 'plan'],
    ['conflict:pr1:abc', 'conflict'],
    ['conflict:pr1:', 'conflict'],
  ])('%s -> %s', (key, reason) => {
    expect(attentionReason(key)).toBe(reason);
  });

  it('names a reason for every key that sessionAttentionKey gives', () => {
    const inputs: Partial<AttentionSessionInput>[] = [
      { status: 'error' },
      { chats: [{ id: 'c1', status: 'error', queued: 0, turnCount: 1 }] },
      { chats: [{ id: 'c1', status: 'awaiting_input', queued: 0, turnCount: 1 }] },
      { chats: [{ id: 'c1', status: 'idle', queued: 0, turnCount: 1, planPending: true }] },
      { pr: { id: 'pr1', state: 'open', mergeable: 'CONFLICTING', headSha: 'a' } },
    ];
    expect(inputs.map((patch) => attentionReason(sessionAttentionKey({ ...BASE, ...patch })))).toEqual([
      'failed',
      'failed',
      'reply',
      'plan',
      'conflict',
    ]);
  });
});

describe('attentionBadgeLabel', () => {
  it.each<[number | undefined, string | null]>([
    [undefined, null],
    [0, null],
    [-1, null],
    [1, '1'],
    [99, '99'],
    [100, '99+'],
    [2500, '99+'],
  ])('%s -> %s', (count, label) => {
    expect(attentionBadgeLabel(count)).toBe(label);
  });
});

describe('contextAttention (pglite)', () => {
  const OWNER = 'user-owner';
  const OTHER = 'user-other';
  let db: Database;
  let cleanup: () => Promise<void>;

  async function session(
    id: string,
    opts: {
      workspaceId?: string;
      spaceId?: string | null;
      status?: string;
      kind?: string;
      archived?: boolean;
      pullRequestId?: string;
      chats?: { status: string; queued?: number; closed?: boolean; turnCount?: number }[];
    } = {},
  ): Promise<void> {
    const workspaceId = opts.workspaceId ?? 'ws1';
    await db.insert(workbenchesTable).values({
      id,
      workspaceId,
      repositoryId: opts.kind === 'thread' ? null : `repo-${workspaceId}`,
      repoFullName: opts.kind === 'thread' ? '' : 'acme/app',
      kind: opts.kind ?? 'session',
      name: id,
      branch: `tom/${id}`,
      baseBranch: 'main',
      runtime: 'sandbox',
      agent: 'claude',
      status: opts.status ?? 'ready',
      sandboxState: 'running',
      spaceId: opts.spaceId ?? null,
      pullRequestId: opts.pullRequestId ?? null,
      archivedAt: opts.archived ? new Date() : null,
    });
    let n = 0;
    for (const chat of opts.chats ?? [{ status: 'idle' }]) {
      await db.insert(chatsTable).values({
        id: `${id}-chat-${n++}`,
        workbenchId: id,
        workspaceId,
        title: 'Chat',
        agent: 'claude',
        status: chat.status,
        turnCount: chat.turnCount ?? 1,
        queuedMessages: Array.from({ length: chat.queued ?? 0 }, (_, i) => ({ id: `q${i}`, text: 'hi' })) as never,
        closedAt: chat.closed ? new Date() : null,
      });
    }
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: OWNER });
    await seedUser(db, { id: OTHER });
    await db.insert(workspacesTable).values([
      { id: 'ws1', ownerId: OWNER, name: 'PostHog', settings: {} },
      { id: 'ws2', ownerId: OWNER, name: 'Side', settings: {} },
      { id: 'ws-other', ownerId: OTHER, name: 'Theirs', settings: {} },
    ]);
    await db.insert(repositoriesTable).values(
      ['ws1', 'ws2', 'ws-other'].map((ws) => ({
        id: `repo-${ws}`,
        workspaceId: ws,
        name: 'acme/app',
        url: 'https://github.com/acme/app',
      })),
    );
    await db.insert(teamsTable).values({ id: 'team1', name: 'Acme' });
    await db.insert(spacesTable).values({ id: 'sp1', teamId: 'team1', name: 'Growth' });
    await db.insert(prTable).values([
      { id: 'pr-conflict', workspaceId: 'ws1', repositoryId: 'repo-ws1', owner: 'acme', repo: 'app', number: 1, state: 'open', lastSummary: { mergeable: 'CONFLICTING' } as never },
      { id: 'pr-clean', workspaceId: 'ws1', repositoryId: 'repo-ws1', owner: 'acme', repo: 'app', number: 2, state: 'open', lastSummary: { mergeable: 'MERGEABLE' } as never },
    ]);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('counts what waits on me, per workspace and per space', async () => {
    await session('question', { chats: [{ status: 'awaiting_input' }] });
    await session('failed', { status: 'error' });
    await session('conflict', { pullRequestId: 'pr-conflict' });
    await session('clean-pr', { pullRequestId: 'pr-clean' });
    await session('working', { chats: [{ status: 'running' }, { status: 'awaiting_input' }] });
    await session('queued', { chats: [{ status: 'awaiting_input', queued: 2 }] });
    await session('closed-tab', { chats: [{ status: 'error', closed: true }, { status: 'idle' }] });
    await session('archived', { status: 'error', archived: true });
    await session('idle');
    await session('in-space', { spaceId: 'sp1', chats: [{ status: 'awaiting_input' }] });
    await session('ws2-thread', { workspaceId: 'ws2', kind: 'thread', chats: [{ status: 'error' }] });
    await session('theirs', { workspaceId: 'ws-other', chats: [{ status: 'awaiting_input' }] });

    expect(await contextAttention(db, OWNER)).toEqual({
      workspaces: { ws1: 4, ws2: 1 },
      spaces: { sp1: 1 },
      workspaceSpaces: { ws1: { sp1: 1 } },
      sessions: { question: 'reply', failed: 'failed', conflict: 'conflict', 'in-space': 'reply', 'ws2-thread': 'failed' },
    });
  });

  describe('a plan that waits for approval', () => {
    const PLAN = 'I read the code.\n\n```talyn-plan\n1. Change the list.\n2. Add tests.\n```';
    let seq = 0;
    /** Append transcript events the way a turn stores them; the trigger fills `workbench_search_text`. */
    const transcript = async (chatId: string, turn: number, items: ['user' | 'assistant', string][]) => {
      await db.insert(eventsTable).values(
        items.map(([type, text]) => ({
          chatId,
          seq: ++seq,
          turn,
          event: { type, message: { role: type, content: [{ type: 'text', text }] } },
        })),
      );
    };
    const toolEvents = async (chatId: string, turn: number) => {
      await db.insert(eventsTable).values([
        { chatId, seq: ++seq, turn, event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } } },
        { chatId, seq: ++seq, turn, event: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file' }] } } },
        { chatId, seq: ++seq, turn, event: { type: 'result', subtype: 'success', result: 'done' } },
      ]);
    };
    beforeEach(() => {
      seq = 0;
    });

    it.each<[string, ['user' | 'assistant', string][], boolean]>([
      ['a plan block at the end of the reply', [['user', 'Plan it'], ['assistant', PLAN]], true],
      ['a plan block before more text', [['user', 'Plan it'], ['assistant', PLAN], ['assistant', 'Tell me what you think.']], true],
      ['a tilde fence', [['user', 'Plan it'], ['assistant', '~~~talyn-plan\nThe plan\n~~~']], true],
      ['a four-backtick fence with a code block inside', [['user', 'Plan it'], ['assistant', '````talyn-plan\nRun:\n```sh\nnpm test\n```\n````']], true],
      ['an unclosed plan block', [['user', 'Plan it'], ['assistant', 'Here:\n```talyn-plan\n1. Do it']], true],
      ['a plan the person approved', [['user', 'Plan it'], ['assistant', PLAN], ['user', 'Approved. Build the plan.']], false],
      ['a plan the person answered after a later reply', [['user', 'Plan it'], ['assistant', PLAN], ['user', 'Keep planning'], ['assistant', 'Which file?']], false],
      ['a reply with no plan', [['user', 'Fix it'], ['assistant', 'Done.']], false],
      ['a reply that names the fence in a sentence', [['user', 'How?'], ['assistant', 'I end with a ```talyn-plan block in plan mode.']], false],
      ['a plan block from the person', [['user', PLAN]], false],
    ])('%s', async (_label, items, counted) => {
      await session('s1');
      await transcript('s1-chat-0', 1, items);
      expect((await contextAttention(db, OWNER)).sessions).toEqual(counted ? { s1: 'plan' } : {});
    });

    // The plan check reads `workbench_search_text`, which the owner-scoped role
    // may not read in production. pglite has no roles, so prove the chat query
    // does not run on the handle the route passes in.
    it('reads chats on the pool, not on the owner-scoped handle', async () => {
      await session('s1');
      await transcript('s1-chat-0', 1, [['user', 'Plan it'], ['assistant', PLAN]]);
      let selects = 0;
      const scoped = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'select') selects++;
          return Reflect.get(target, prop, receiver);
        },
      });
      expect((await contextAttention(scoped, OWNER)).sessions).toEqual({ s1: 'plan' });
      expect(selects).toBe(1);
    });

    it('counts a plan after tool calls and their results', async () => {
      await session('s1');
      await transcript('s1-chat-0', 1, [['user', 'Plan it']]);
      await toolEvents('s1-chat-0', 1);
      await transcript('s1-chat-0', 1, [['assistant', PLAN]]);
      expect(await contextAttention(db, OWNER)).toEqual({ workspaces: { ws1: 1 }, spaces: {}, workspaceSpaces: {}, sessions: { s1: 'plan' } });
    });

    it.each<[string, Parameters<typeof session>[1]]>([
      ['a running turn', { chats: [{ status: 'running' }] }],
      ['a queued message', { chats: [{ status: 'idle', queued: 1 }] }],
      ['a closed tab', { chats: [{ status: 'idle', closed: true }] }],
      ['an archived session', { archived: true }],
    ])('does not count a plan in %s', async (_label, opts) => {
      await session('s1', opts);
      await transcript('s1-chat-0', 1, [['user', 'Plan it'], ['assistant', PLAN]]);
      expect((await contextAttention(db, OWNER)).sessions).toEqual({});
    });

    it('counts a plan in a space for the space and the workspace', async () => {
      await session('s1', { spaceId: 'sp1' });
      await transcript('s1-chat-0', 1, [['user', 'Plan it'], ['assistant', PLAN]]);
      expect(await contextAttention(db, OWNER)).toEqual({ workspaces: { ws1: 1 }, spaces: { sp1: 1 }, workspaceSpaces: { ws1: { sp1: 1 } }, sessions: { s1: 'plan' } });
    });

    it('keeps counting a plan until a person answers it', async () => {
      await session('s1', { chats: [{ status: 'idle', turnCount: 1 }] });
      await transcript('s1-chat-0', 1, [['user', 'Plan it'], ['assistant', PLAN]]);
      await db.update(workbenchesTable).set({ attentionAck: 'plan:s1-chat-0@1' }).where(eq(workbenchesTable.id, 's1'));
      expect((await contextAttention(db, OWNER)).sessions).toEqual({ s1: 'plan' });

      await db.update(chatsTable).set({ turnCount: 2 }).where(eq(chatsTable.id, 's1-chat-0'));
      await transcript('s1-chat-0', 2, [['user', 'Approve and build']]);
      expect((await contextAttention(db, OWNER)).sessions).toEqual({});
    });
  });

  it('never counts another owner’s sessions', async () => {
    await session('theirs', { workspaceId: 'ws-other', spaceId: 'sp1', chats: [{ status: 'error' }] });
    expect(await contextAttention(db, OWNER)).toEqual({ workspaces: {}, spaces: {}, workspaceSpaces: {}, sessions: {} });
    expect(await contextAttention(db, OTHER)).toEqual({ workspaces: { 'ws-other': 1 }, spaces: { sp1: 1 }, workspaceSpaces: { 'ws-other': { sp1: 1 } }, sessions: { theirs: 'failed' } });
  });

  it('answers empty maps for an owner with no sessions', async () => {
    expect(await contextAttention(db, OWNER)).toEqual({ workspaces: {}, spaces: {}, workspaceSpaces: {}, sessions: {} });
  });

  describe('a session stays counted until its alert is resolved', () => {
    const setChat = (id: string, patch: { status: string; turnCount?: number }) =>
      db.update(chatsTable).set(patch).where(eq(chatsTable.id, id));
    const sessionKeys = async () => (await contextAttention(db, OWNER)).sessions;

    it.each<[string, Parameters<typeof session>[1], string, 'failed' | 'reply' | 'conflict']>([
      ['a question', { chats: [{ status: 'awaiting_input' }] }, 'reply:s1-chat-0@1', 'reply'],
      ['a failed start', { status: 'error' }, 'error', 'failed'],
      ['a failed chat', { chats: [{ status: 'error' }] }, 'chat_error:s1-chat-0@1', 'failed'],
      ['a conflicting PR', { pullRequestId: 'pr-conflict' }, 'conflict:pr-conflict:', 'conflict'],
      ['a question in a space', { spaceId: 'sp1', chats: [{ status: 'awaiting_input' }] }, 'reply:s1-chat-0@1', 'reply'],
    ])('ignores a stored "seen" key for %s', async (_label, opts, key, reason) => {
      await session('s1', opts);
      await db.update(workbenchesTable).set({ attentionAck: key }).where(eq(workbenchesTable.id, 's1'));
      expect(await sessionKeys()).toEqual({ s1: reason });
    });

    it('stops counting a question when the person answers it', async () => {
      await session('s1', { chats: [{ status: 'awaiting_input', turnCount: 1 }] });
      expect(await sessionKeys()).toEqual({ s1: 'reply' });
      await setChat('s1-chat-0', { status: 'running', turnCount: 2 });
      expect(await sessionKeys()).toEqual({});
    });

    it('stops counting a failed chat when it is retried', async () => {
      await session('s1', { chats: [{ status: 'error', turnCount: 1 }] });
      expect(await sessionKeys()).toEqual({ s1: 'failed' });
      await setChat('s1-chat-0', { status: 'running', turnCount: 2 });
      expect(await sessionKeys()).toEqual({});
    });

    it('stops counting a failed start when the session is ready', async () => {
      await session('s1', { status: 'error' });
      expect(await sessionKeys()).toEqual({ s1: 'failed' });
      await db.update(workbenchesTable).set({ status: 'ready' }).where(eq(workbenchesTable.id, 's1'));
      expect(await sessionKeys()).toEqual({});
    });

    it('stops counting conflicts when the PR merges cleanly again', async () => {
      await session('s1', { pullRequestId: 'pr-conflict' });
      expect(await sessionKeys()).toEqual({ s1: 'conflict' });
      await db.update(prTable).set({ lastSummary: { mergeable: 'MERGEABLE', headSha: 'b' } as never }).where(eq(prTable.id, 'pr-conflict'));
      expect(await sessionKeys()).toEqual({});
    });
  });

  it('leaves the big jsonb columns in Postgres', () => {
    const sessions = attentionSessionsQuery(db, OWNER).toSQL().sql;
    expect(sessions).not.toContain('"settings"');
    expect(sessions).not.toContain('"diff_stat"');
    expect(sessions).not.toMatch(/"last_summary"(?! ->>)/);
    const chats = attentionChatsQuery(db, ['a']).toSQL().sql;
    expect(chats).not.toMatch(/"queued_messages"(?!\))/);
    expect(chats).not.toContain('"turn_parser"');
    expect(chats).not.toContain('"agent_backup"');
  });
});
