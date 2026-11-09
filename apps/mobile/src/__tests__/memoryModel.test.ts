import { MAX_MEMORY_BODY_BYTES, MAX_MEMORY_NAME_CHARS, type MemoryEntry, type MemoryEntrySummary, type MemoryReviewRun } from '@talyn/shared';

import {
  MEMORY_EMPTY, WORKSPACE_TARGET, WORKSPACE_TARGET_LABEL, ago, emptyMemoryMessage, groupMemories, liveCountOf, memoryCount, memoryCreateInput,
  memoryDirty, memoryDraftOf, memoryFieldCounts, memoryListQuery, memorySaveRequest, memoryScopeLabel, memorySourceLabel, memoryUpdatePatch,
  reviewLine, sameNameMessage, targetLabel, upsertSummary,
} from '../features/memory/model';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const repos = [{ id: 'r1', fullName: 'acme/web' }, { id: 'r2', fullName: 'acme/api' }];

function summary(overrides: Partial<MemoryEntrySummary> = {}): MemoryEntrySummary {
  return { id: 'm1', workspaceId: 'w1', scope: 'workspace', repositoryId: null, threadId: null, type: 'project', name: 'Build',
    description: 'How to build', bytes: 10, source: { kind: 'user' }, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-08T12:00:00Z',
    forgottenAt: null, ...overrides };
}
const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({ ...summary(overrides), body: 'npm run build', ...overrides });

describe('ago', () => {
  it.each([
    [0, 'just now'], [59_000, 'just now'], [60_000, '1m ago'], [59 * 60_000, '59m ago'], [60 * 60_000, '1h ago'],
    [23 * 3_600_000, '23h ago'], [24 * 3_600_000, '1d ago'], [29 * 86_400_000, '29d ago'], [30 * 86_400_000, '1mo ago'],
    [359 * 86_400_000, '11mo ago'], [364 * 86_400_000, '1y ago'], [365 * 86_400_000, '1y ago'], [-5_000, 'just now'],
  ])('%i ms ago reads %s', (delta, label) => expect(ago(new Date(NOW - delta).toISOString(), NOW)).toBe(label));

  it('says nothing for a bad date', () => expect(ago('nope', NOW)).toBe(''));
});

describe('labels', () => {
  it.each([
    [{ scope: 'workspace' as const }, 'Workspace'],
    [{ scope: 'thread' as const, repositoryId: null }, 'Thread'],
    [{ scope: 'repository' as const, repositoryId: 'r2' }, 'acme/api'],
    [{ scope: 'repository' as const, repositoryId: 'gone' }, 'Repository'],
  ])('scope %j is %s', (value, label) => expect(memoryScopeLabel(value, repos)).toBe(label));

  it.each([
    [{ kind: 'user' as const }, { text: 'Added by you' }],
    [{ kind: 'auto' as const }, { text: 'Saved automatically' }],
    [{ kind: 'session' as const, workbenchId: 'wb1' }, { text: 'Saved by a session', workbenchId: 'wb1' }],
    [{ kind: 'session' as const, workbenchId: '' }, { text: 'Saved by a session' }],
  ])('source %j', (source, expected) => expect(memorySourceLabel(source)).toEqual(expected));

  it.each([
    [WORKSPACE_TARGET, WORKSPACE_TARGET_LABEL], ['r1', 'acme/web'], ['missing', 'Repository'],
  ])('target %s is %s', (target, label) => expect(targetLabel(target, repos)).toBe(label));

  it.each([['', MEMORY_EMPTY], ['build', 'No notes match "build".']])('empty message for %j', (search, message) =>
    expect(emptyMemoryMessage(search)).toBe(message));

  it('names the entry the server updated', () => expect(sameNameMessage('Build')).toBe('Updated the entry "Build", which had the same name'));
});

describe('groups', () => {
  it('orders workspace, repositories by name, then threads, and drops empty groups', () => {
    const groups = groupMemories([
      summary({ id: 't', scope: 'thread', threadId: 'th' }),
      summary({ id: 'a', scope: 'repository', repositoryId: 'r1' }),
      summary({ id: 'b', scope: 'repository', repositoryId: 'r2' }),
      summary({ id: 'w' }),
      summary({ id: 'a2', scope: 'repository', repositoryId: 'r1' }),
    ], repos);
    expect(groups.map((g) => [g.label, g.mono, g.entries.map((e) => e.id)])).toEqual([
      ['Workspace', false, ['w']], ['acme/api', true, ['b']], ['acme/web', true, ['a', 'a2']], ['Threads', false, ['t']],
    ]);
  });

  it.each([[null], [undefined], [[]]])('no entries (%j) is no groups', (entries) => expect(groupMemories(entries, repos)).toEqual([]));

  it('a repository the workspace no longer has still gets a group', () => {
    expect(groupMemories([summary({ scope: 'repository', repositoryId: 'gone' })], repos).map((g) => g.label)).toEqual(['Repository']);
  });
});

describe('counts and queries', () => {
  it('counts live entries only', () => expect(liveCountOf([summary(), summary({ id: 'x', forgottenAt: '2026-11-09T00:00:00Z' })])).toBe(1));

  it.each([
    [null, null], [0, { label: '0 of 500', full: false }], [499, { label: '499 of 500', full: false }],
    [500, { label: '500 of 500', full: true }], [501, { label: '501 of 500', full: true }],
  ])('memoryCount(%j)', (count, expected) => expect(memoryCount(count)).toEqual(expected));

  it.each([
    ['', false, { workspaceId: 'w1' }],
    ['build', false, { workspaceId: 'w1', q: 'build' }],
    ['', true, { workspaceId: 'w1', includeForgotten: true }],
    ['x', true, { workspaceId: 'w1', q: 'x', includeForgotten: true }],
  ])('query for %j, forgotten %s', (search, forgotten, expected) => expect(memoryListQuery('w1', search, forgotten)).toEqual(expected));
});

describe('review line', () => {
  const run = (overrides: Partial<MemoryReviewRun>): MemoryReviewRun => ({ id: 'run', workspaceId: 'w1', trigger: 'manual', status: 'started',
    workbenchId: 'wb', error: null, createdAt: new Date(NOW - 2 * 3_600_000).toISOString(), ...overrides } as MemoryReviewRun);
  it.each([
    ['none', undefined, null],
    ['failed with a reason', run({ status: 'failed', error: 'No agent' }), { text: 'Last review failed: No agent' }],
    ['failed without a reason', run({ status: 'failed' }), { text: 'Last review failed: unknown error' }],
    ['starting', run({ status: 'starting' }), { text: 'A review is starting' }],
    ['started with a thread', run({}), { text: 'Last review: 2h ago', workbenchId: 'wb' }],
    ['started without a thread', run({ workbenchId: null }), { text: 'Last review: 2h ago' }],
  ])('%s', (_name, value, expected) => expect(reviewLine(value, NOW)).toEqual(expected));
});

describe('editor', () => {
  it.each([
    ['new', null, { target: WORKSPACE_TARGET, type: 'project', name: '', description: '', body: '' }],
    ['workspace entry', entry({ type: 'user' }), { target: WORKSPACE_TARGET, type: 'user', name: 'Build', description: 'How to build', body: 'npm run build' }],
    ['repository entry', entry({ scope: 'repository', repositoryId: 'r2' }), { target: 'r2' }],
  ])('draft of %s', (_name, value, expected) => expect(memoryDraftOf(value)).toMatchObject(expected));

  it.each([
    ['nothing changed', {}, {}],
    ['name', { name: 'Build cmd' }, { name: 'Build cmd' }],
    ['type and body', { type: 'reference' as const, body: 'make' }, { type: 'reference', body: 'make' }],
    ['description', { description: '' }, { description: '' }],
  ])('patch: %s', (_name, change, expected) => {
    const original = entry();
    expect(memoryUpdatePatch(original, { ...memoryDraftOf(original), ...change })).toEqual(expected);
  });

  it.each([
    ['workspace', WORKSPACE_TARGET, { scope: 'workspace' }],
    ['repository', 'r1', { scope: 'repository', repositoryId: 'r1' }],
  ])('create input for a %s', (_name, target, expected) => {
    const input = memoryCreateInput('w1', { ...memoryDraftOf(null), target, name: 'n', description: 'd', body: 'b' });
    expect(input).toMatchObject({ workspaceId: 'w1', type: 'project', name: 'n', description: 'd', body: 'b', ...expected });
    if (target === WORKSPACE_TARGET) expect(input).not.toHaveProperty('repositoryId');
  });

  it.each([
    ['unchanged edit', entry(), {}, 'none'],
    ['valid edit', entry(), { name: 'New name' }, 'update'],
    ['edit with a blank name', entry(), { name: '   ' }, 'invalid'],
    ['edit with a long name', entry(), { name: 'x'.repeat(MAX_MEMORY_NAME_CHARS + 1) }, 'invalid'],
    ['edit with a huge body', entry(), { body: 'x'.repeat(MAX_MEMORY_BODY_BYTES + 1) }, 'invalid'],
    ['valid create', null, { name: 'n', description: 'd', body: 'b' }, 'create'],
    ['create without a name', null, { description: 'd', body: 'b' }, 'invalid'],
    ['create for a repository', null, { target: 'r1', name: 'n', description: 'd', body: 'b' }, 'create'],
  ] as const)('save request: %s', (_name, original, change, kind) => {
    const request = memorySaveRequest('w1', original, { ...memoryDraftOf(original), ...change });
    expect(request.kind).toBe(kind);
    if (request.kind === 'invalid') expect(request.error).toBeTruthy();
  });

  it.each([
    ['empty create', null, {}, false],
    ['create with a name', null, { name: 'x' }, true],
    ['create with spaces only', null, { body: '  ' }, false],
    ['unchanged edit', entry(), {}, false],
    ['changed edit', entry(), { body: 'other' }, true],
  ] as const)('dirty: %s', (_name, original, change, dirty) =>
    expect(memoryDirty(original, { ...memoryDraftOf(original), ...change })).toBe(dirty));

  it('counts trimmed characters and body bytes', () => {
    const counts = memoryFieldCounts({ name: ' ab ', description: 'x'.repeat(201), body: 'é'.repeat(MAX_MEMORY_BODY_BYTES / 2 + 1) });
    expect(counts.name).toEqual({ label: '2 / 64', over: false });
    expect(counts.description).toEqual({ label: '201 / 200', over: true });
    expect(counts.body).toEqual({ label: '8.0 KB of 8.0 KB', over: true });
  });

  it('upserts a summary and drops the body', () => {
    const list = [summary({ id: 'a' }), summary({ id: 'b' })];
    const replaced = upsertSummary(list, entry({ id: 'b', name: 'B2' }));
    expect(replaced.map((e) => e.name)).toEqual(['Build', 'B2']);
    expect(replaced[1]).not.toHaveProperty('body');
    expect(upsertSummary(list, summary({ id: 'c' })).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});
