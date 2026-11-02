import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import {
  publicSessionStatus,
  repositoryFullName,
  toPublicChat,
  toPublicEvent,
  toPublicRepository,
  toPublicSession,
  toPublicWorkspace,
} from '../services/public/projections.js';
import {
  getChatQuery,
  getSessionQuery,
  listRepositoriesQuery,
  listSessionsQuery,
  listWorkspacesQuery,
  openChatsQuery,
} from '../services/public/queries.js';
import { decodeCursor, encodeCursor, pageOf } from '../services/public/cursor.js';
import { PublicApiError } from '../services/public/errors.js';

/**
 * The projections are the only exit from `/v1`. These tests hold two things:
 * no secret or internal field leaves, and no list ships a jsonb blob.
 */

let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'owner-a' });
  await testDb.db.insert(workspaces).values({
    id: 'ws-a',
    ownerId: 'owner-a',
    name: 'A',
    description: 'secret description',
    logo: { kind: 'emoji', value: 'x' },
    settings: { promptTemplates: { secret: 'workspace-setting' } },
  });
  await testDb.db.insert(repositories).values({
    id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app.git', defaultBranch: 'trunk',
    settings: { previewTarget: 'secret-repo-setting' } as never,
  });
  await testDb.db.insert(workbenches).values({
    id: 'wb-1',
    workspaceId: 'ws-a',
    repositoryId: 'repo-a',
    repoFullName: 'acme/app',
    name: 'calm-river',
    branch: 'talyn/calm-river',
    baseBranch: 'main',
    runtime: 'local',
    agent: 'claude',
    deviceId: 'device-secret',
    localPath: '/Users/someone/secret/path',
    sandboxId: 'sandbox-secret',
    fleetHost: 'fleet-host-secret',
    status: 'ready',
    settings: { internetAccess: false, fleetSandboxId: 'fleet-sandbox-secret', fleetAccountId: 'fleet-account-secret' },
    diffStat: { added: 3, removed: 1, files: 2, uncommittedStats: { added: 9, removed: 9, files: 9 } } as never,
  });
  await testDb.db.insert(workbenchChats).values({
    id: 'chat-1',
    workbenchId: 'wb-1',
    workspaceId: 'ws-a',
    title: 'Chat',
    agent: 'claude',
    agentSessionId: 'agent-session-secret',
    queuedMessages: [
      { id: 'm1', text: 'queued text secret', queuedAt: '2026-11-02T00:00:00Z', attachments: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'BASE64SECRET' }] },
      { id: 'm2', text: 'second', queuedAt: '2026-11-02T00:00:01Z' },
    ] as never,
  });
});

afterAll(async () => {
  await testDb.cleanup();
});

const SECRETS = [
  'device-secret',
  '/Users/someone/secret/path',
  'sandbox-secret',
  'fleet-host-secret',
  'fleet-sandbox-secret',
  'fleet-account-secret',
  'agent-session-secret',
  'queued text secret',
  'BASE64SECRET',
  'secret description',
  'workspace-setting',
  'secret-repo-setting',
];

function expectNoSecrets(value: unknown): void {
  const json = JSON.stringify(value);
  for (const secret of SECRETS) expect(json, secret).not.toContain(secret);
}

describe('public projections', () => {
  it('a session carries its public fields only', async () => {
    const [row] = await getSessionQuery('wb-1');
    const session = toPublicSession(row, await openChatsQuery('wb-1'));
    expectNoSecrets(session);
    expect(Object.keys(session).sort()).toEqual(
      [
        'object', 'id', 'workspace_id', 'kind', 'thread_id', 'repository_id', 'repository_full_name', 'name', 'title',
        'branch', 'base_branch', 'runtime', 'agent', 'model', 'status', 'status_message', 'pull_request_id',
        'internet_access', 'auto_create_pr', 'diff_stat', 'archived_at', 'created_at', 'updated_at', 'chats',
      ].sort(),
    );
    expect(session).toMatchObject({
      object: 'session',
      runtime: 'local',
      repository_full_name: 'acme/app',
      internet_access: false,
      auto_create_pr: null,
      diff_stat: { added: 3, removed: 1, files: 2 },
      status: 'ready',
    });
    expect(session.chats).toHaveLength(1);
  });

  it('a chat says how many messages are queued, never what they are', async () => {
    const [row] = await getChatQuery('chat-1');
    const chat = toPublicChat(row);
    expectNoSecrets(chat);
    expect(chat.queued_message_count).toBe(2);
    expect(Object.keys(chat).sort()).toEqual(
      [
        'object', 'id', 'session_id', 'title', 'agent', 'model', 'effort', 'plan_mode', 'status', 'status_message',
        'turn_count', 'queued_message_count', 'closed_at', 'created_at', 'updated_at',
      ].sort(),
    );
  });

  it('a workspace and a repository carry no settings, logo or description', async () => {
    const [ws] = await listWorkspacesQuery('owner-a', null, null, 10);
    const [repo] = await listRepositoriesQuery('ws-a', null, 10);
    expectNoSecrets([toPublicWorkspace(ws), toPublicRepository(repo)]);
    expect(Object.keys(toPublicWorkspace(ws)).sort()).toEqual(['created_at', 'id', 'name', 'object', 'updated_at']);
    expect(toPublicRepository(repo)).toMatchObject({ full_name: 'acme/app', default_branch: 'trunk' });
  });

  it.each([
    ['https://github.com/acme/app.git', 'x', 'acme/app'],
    ['git@github.com:acme/app.git', 'x', 'acme/app'],
    ['https://github.com/acme/app', 'x', 'acme/app'],
    ['https://gitlab.com/acme/app', 'fallback/name', 'fallback/name'],
  ])('reads the full name of %s', (url, name, expected) => {
    expect(repositoryFullName(url, name)).toBe(expected);
  });

  it.each([
    ['ready', null, 'ready'],
    ['provisioning', null, 'provisioning'],
    ['moving', null, 'moving'],
    ['error', null, 'error'],
    ['ready', new Date(), 'archived'],
    ['archiveError', new Date(), 'archive_error'],
    ['archiveError', null, 'archive_error'],
    ['something-new', null, 'error'],
  ] as const)('status %s, archived %s reads as %s', (status, archivedAt, expected) => {
    expect(publicSessionStatus({ status, archivedAt })).toBe(expected);
  });

  it('an event lifts its type and keeps the agent event as data', () => {
    expect(toPublicEvent('chat-1', { seq: 7, turn: 2, event: { type: 'assistant', message: { content: [] } } })).toEqual({
      object: 'event',
      chat_id: 'chat-1',
      seq: 7,
      turn: 2,
      type: 'assistant',
      data: { type: 'assistant', message: { content: [] }, seq: 7 },
    });
  });
});

describe('egress', () => {
  /** The SELECT list: what the database ships back. */
  const selectList = (sqlText: string) => sqlText.slice(0, sqlText.indexOf(' from '));

  it('the session reads never ship the settings or diff_stat blobs, nor any secret column', () => {
    for (const query of [listSessionsQuery('ws-a', {}, null, 10), getSessionQuery('wb-1')]) {
      const select = selectList(query.toSQL().sql);
      for (const column of ['"device_id"', '"local_path"', '"sandbox_id"', '"fleet_host"', '"sandbox_state"', '"pushed_head_shas"']) {
        expect(select).not.toContain(column);
      }
      // jsonb columns appear only as `->>` reads of one key.
      expect(select).not.toMatch(/"settings"(?!\s*->>)/);
      expect(select).not.toMatch(/"diff_stat"(?!\s*->>)/);
    }
  });

  it('the chat reads count the queue in SQL and never ship it', () => {
    for (const query of [getChatQuery('chat-1'), openChatsQuery('wb-1')]) {
      const select = selectList(query.toSQL().sql);
      expect(select).toContain('jsonb_array_length("queued_messages")');
      expect(select.replace('jsonb_array_length("queued_messages")', '')).not.toContain('queued_messages');
      expect(select).not.toContain('"agent_session_id"');
      expect(select).not.toContain('"turn_parser"');
    }
  });

  it('the workspace and repository reads ship no jsonb', () => {
    expect(selectList(listWorkspacesQuery('owner-a', null, null, 10).toSQL().sql)).not.toMatch(/"logo"|"settings"|"description"/);
    expect(selectList(listRepositoriesQuery('ws-a', null, 10).toSQL().sql)).not.toContain('"settings"');
  });

  it('a list asks for one row more than the page, to know has_more', () => {
    expect(listSessionsQuery('ws-a', {}, null, 10).toSQL().params).toContain(11);
  });
});

describe('cursors', () => {
  it('round-trips and pages by created_at then id', async () => {
    await testDb.db.insert(workspaces).values([
      { id: 'ws-p1', ownerId: 'owner-a', name: 'P1', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { id: 'ws-p2', ownerId: 'owner-a', name: 'P2', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { id: 'ws-p3', ownerId: 'owner-a', name: 'P3', createdAt: new Date('2025-01-01T00:00:00.000Z') },
    ]);
    const bound = ['ws-p1', 'ws-p2', 'ws-p3'];
    const first = pageOf(await listWorkspacesQuery('owner-a', bound, null, 2), 2);
    expect(first.rows.map((r) => r.id)).toEqual(['ws-p2', 'ws-p1']);
    expect(first.hasMore).toBe(true);
    const second = pageOf(await listWorkspacesQuery('owner-a', bound, decodeCursor(first.nextCursor!), 2), 2);
    expect(second.rows.map((r) => r.id)).toEqual(['ws-p3']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('keeps microseconds, so rows in one millisecond still page', () => {
    const cursor = { t: '2026-11-02T09:30:00.123456Z', id: 'x' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ['not base64 JSON', 'nope'],
    ['JSON of the wrong shape', Buffer.from(JSON.stringify({ a: 1 })).toString('base64url')],
    ['a time in milliseconds', Buffer.from(JSON.stringify({ t: '2026-11-02T09:30:00.123Z', id: 'x' })).toString('base64url')],
    ['SQL in the time', Buffer.from(JSON.stringify({ t: "2026'; drop table x; --", id: 'x' })).toString('base64url')],
  ])('refuses %s with a 400 on cursor', (_label, raw) => {
    try {
      decodeCursor(raw);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(PublicApiError);
      expect((err as PublicApiError).options.param).toBe('cursor');
      expect((err as PublicApiError).status).toBe(400);
    }
  });

  it('reads an absent cursor as the first page', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });
});
