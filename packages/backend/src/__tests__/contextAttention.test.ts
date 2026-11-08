import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  attentionBadgeLabel,
  countContextAttention,
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
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
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
    ['an archived session that failed', { archivedAt: new Date(), status: 'error' }, false],
    ['a session with archived status', { status: 'archived', chats: [{ status: 'awaiting_input', queued: 0 }] }, false],
    ['a session with no chats', { chats: [] }, false],
  ])('%s', (_label, patch, expected) => {
    expect(sessionNeedsAttention({ ...BASE, ...patch })).toBe(expected);
  });
});

describe('countContextAttention', () => {
  it('counts a space session for its workspace and its space', () => {
    expect(
      countContextAttention([
        { workspaceId: 'ws1', spaceId: null },
        { workspaceId: 'ws1', spaceId: 'sp1' },
        { workspaceId: 'ws2', spaceId: 'sp1' },
      ]),
    ).toEqual({ workspaces: { ws1: 2, ws2: 1 }, spaces: { sp1: 2 } });
  });

  it('answers empty maps for no sessions', () => {
    expect(countContextAttention([])).toEqual({ workspaces: {}, spaces: {} });
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
      chats?: { status: string; queued?: number; closed?: boolean }[];
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
    });
  });

  it('never counts another owner’s sessions', async () => {
    await session('theirs', { workspaceId: 'ws-other', spaceId: 'sp1', chats: [{ status: 'error' }] });
    expect(await contextAttention(db, OWNER)).toEqual({ workspaces: {}, spaces: {} });
    expect(await contextAttention(db, OTHER)).toEqual({ workspaces: { 'ws-other': 1 }, spaces: { sp1: 1 } });
  });

  it('answers empty maps for an owner with no sessions', async () => {
    expect(await contextAttention(db, OWNER)).toEqual({ workspaces: {}, spaces: {} });
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
