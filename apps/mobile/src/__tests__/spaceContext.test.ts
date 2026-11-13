import type { Space, SpacePresenceMember, SpaceSessionRow, SpacesTeam, SpaceTaskRow } from '@talyn/shared';

import { composerChips, type NewWorkForm, type NewWorkPullRequest } from '../features/create/model';
import { addsRepositoryNote, spaceBlockedReason, spaceCreateBody, spacePlaceholder, spacePullRequestRows, spaceRepositories } from '../features/create/space';
import type { SpaceItems } from '../features/spaces/data';
import { ACTIVE_GROUP, isActiveState, spaceDrawerEntries, spaceRowState, type SpaceDrawerEntry, type SpaceDrawerInput } from '../features/spaces/drawer';
import { inPersonalList, openTarget, personalItems } from '../features/spaces/model';
import { switcherLabel, switcherSections } from '../features/spaces/switcher';
import { ContextController, contextKey, contextsEqual, resolveContext, type ActiveContext, type ContextSnapshot } from '../workspaces/context';
import { session } from './workflowFixtures';

const space = (patch: Partial<Space> = {}): Space => ({ id: 's1', teamId: 't1', name: 'Design', color: '#336699', image: null,
  createdByUserId: null, archivedAt: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...patch });
const team = (patch: Partial<SpacesTeam> = {}): SpacesTeam => ({ id: 't1', name: 'Acme', role: 'member', homeWorkspaceId: 'w1',
  spaces: [space()], createdAt: '2026-11-01T00:00:00Z', ...patch });
const row = (patch: Partial<SpaceSessionRow> = {}): SpaceSessionRow => ({ id: 'r1', spaceId: 's1', workspaceId: 'w1', kind: 'session', threadId: null,
  name: 'r1-name', title: 'Row one', status: 'ready', sandboxState: 'running', running: false, repoFullName: 'acme/app', branch: 'tom/one',
  baseBranch: 'main', agent: 'claude', model: null, pullRequest: null, creator: { userId: 'u1', githubLogin: 'ana', avatarUrl: null },
  lastActivityAt: null, archivedAt: null, createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T10:00:00Z', ...patch } as SpaceSessionRow);
const task = (patch: Partial<SpaceTaskRow> = {}): SpaceTaskRow => ({ id: 'k1', spaceId: 's1', workspaceId: 'w2', type: 'pr_response', status: 'in_progress',
  title: 'Fix checks', repoFullName: 'acme/app', branch: null, pullRequest: null, creator: { userId: 'u2', githubLogin: 'ben', avatarUrl: null },
  createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T10:00:00Z', completedAt: null, ...patch });
const viewer = (patch: Partial<SpacePresenceMember> = {}): SpacePresenceMember => ({ userId: 'u2', githubLogin: 'ben', avatarUrl: null,
  sessionId: 'r1', state: 'active', at: 0, ...patch });
const ready = (spaceId: string | null): ContextSnapshot => ({ status: 'ready', spaceId });

describe('resolveContext', () => {
  const teams = [team()];
  it.each<[string, Partial<Parameters<typeof resolveContext>[0]>, ActiveContext['kind'], boolean]>([
    ['saved choice still loading', { saved: { status: 'loading', spaceId: null } }, 'pending', false],
    ['no saved space', { saved: ready(null), offered: null }, 'personal', false],
    ['features loading', { offered: null }, 'pending', false],
    ['spaces off keeps the choice', { offered: false }, 'personal', false],
    ['teams loading', { teams: undefined, teamsLoading: true }, 'pending', false],
    ['teams failed keeps the choice', { teams: undefined, teamsLoading: false }, 'personal', false],
    ['space found', {}, 'space', false],
    ['space gone is forgotten', { saved: ready('gone') }, 'personal', true],
    ['archived space left the list', { teams: [team({ spaces: [] })] }, 'personal', true],
  ])('%s', (_name, patch, kind, forget) => {
    const result = resolveContext({ saved: ready('s1'), offered: true, teams, teamsLoading: false, workspaceId: 'w1', ...patch });
    expect(result.context.kind).toBe(kind);
    expect(result.forget).toBe(forget);
    if (kind === 'personal') expect(result.context).toEqual({ kind: 'personal', workspaceId: 'w1' });
  });

  it('carries the space and its team', () => {
    const { context } = resolveContext({ saved: ready('s1'), offered: true, teams, teamsLoading: false, workspaceId: 'w1' });
    expect(context).toMatchObject({ kind: 'space', spaceId: 's1', space: { name: 'Design' }, team: { name: 'Acme' } });
  });

  it.each([
    [{ kind: 'personal', workspaceId: 'a' }, { kind: 'personal', workspaceId: 'a' }, true],
    [{ kind: 'personal', workspaceId: 'a' }, { kind: 'personal', workspaceId: 'b' }, false],
    [{ kind: 'space', spaceId: 's' }, { kind: 'space', spaceId: 's' }, true],
    [{ kind: 'space', spaceId: 's' }, { kind: 'personal', workspaceId: 's' }, false],
  ] as const)('contexts equal %#', (a, b, equal) => { expect(contextsEqual(a, b)).toBe(equal); });
});

describe('ContextController', () => {
  const prefs = () => {
    const values = new Map<string, string>();
    return { values, getItem: jest.fn(async (key: string) => values.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
      removeItem: jest.fn(async (key: string) => { values.delete(key); }) };
  };

  it('persists per account and restores on a cold start', async () => {
    const store = prefs();
    const first = new ContextController(store, 'env');
    await first.load('user-a');
    expect(first.getSnapshot()).toEqual(ready(null));
    await first.select('s1');
    expect(store.values.get(contextKey('env', 'user-a'))).toBe('s1');
    const cold = new ContextController(store, 'env');
    await cold.load('user-a');
    expect(cold.getSnapshot()).toEqual(ready('s1'));
    const other = new ContextController(store, 'env');
    await other.load('user-b');
    expect(other.getSnapshot()).toEqual(ready(null));
  });

  it.each([['Personal removes the key', null], ['a space writes it', 's2']])('select: %s', async (_name, spaceId) => {
    const store = prefs();
    store.values.set(contextKey('env', 'u'), 's1');
    const controller = new ContextController(store, 'env');
    await controller.load('u');
    await controller.select(spaceId);
    expect(controller.getSnapshot().spaceId).toBe(spaceId);
    expect(store.values.get(contextKey('env', 'u')) ?? null).toBe(spaceId);
  });

  it('keeps the choice on screen when the write fails, and treats a failed read as Personal', async () => {
    const store = prefs();
    store.setItem.mockRejectedValueOnce(new Error('full'));
    const controller = new ContextController(store, 'env');
    await controller.load('u');
    await controller.select('s1');
    expect(controller.getSnapshot().spaceId).toBe('s1');
    store.getItem.mockRejectedValueOnce(new Error('broken'));
    const cold = new ContextController(store, 'env');
    await cold.load('u');
    expect(cold.getSnapshot()).toEqual(ready(null));
  });

  it('ignores a choice before load and clears on sign-out', async () => {
    const store = prefs();
    const controller = new ContextController(store, 'env');
    await controller.select('s1');
    expect(store.setItem).not.toHaveBeenCalled();
    await controller.load('u');
    await controller.select('s1');
    await controller.clear('u');
    expect(controller.getSnapshot()).toEqual({ status: 'idle', spaceId: null });
    expect(store.values.size).toBe(0);
  });
});

describe('switcher', () => {
  const workspaces = [{ id: 'w1', name: 'Home' }, { id: 'w2', name: 'Side' }];
  const personal: ActiveContext = { kind: 'personal', workspaceId: 'w2' };
  const inSpace: ActiveContext = { kind: 'space', spaceId: 's2', space: space({ id: 's2' }), team: team() };
  const teams = [team({ spaces: [space(), space({ id: 's2', name: 'Growth' })] }), team({ id: 't2', name: 'Empty', spaces: [] })];

  it.each<[string, Parameters<typeof switcherSections>[0], Array<[string, string | undefined, string[]]>]>([
    ['spaces off: workspaces only', { workspaces, teams, offered: false, context: personal },
      [['Workspaces', undefined, ['Home', 'Side✓']]]],
    ['personal context checks the workspace', { workspaces, teams, offered: true, context: personal },
      [['Personal', undefined, ['Home', 'Side✓']], ['Acme', undefined, ['Design', 'Growth']], ['Empty', 'No spaces yet.', []]]],
    ['space context checks the space only', { workspaces, teams, offered: true, context: inSpace },
      [['Personal', undefined, ['Home', 'Side']], ['Acme', undefined, ['Design', 'Growth✓']], ['Empty', 'No spaces yet.', []]]],
    ['teams loading', { workspaces, teams: undefined, offered: true, context: personal },
      [['Personal', undefined, ['Home', 'Side✓']], ['Teams', 'Loading your teams.', []]]],
    ['teams failed', { workspaces, teams: undefined, teamsFailed: true, offered: true, context: personal },
      [['Personal', undefined, ['Home', 'Side✓']], ['Teams', 'Could not load your teams.', []]]],
  ])('%s', (_name, input, expected) => {
    expect(switcherSections(input).map((section) => [section.title, section.note,
      section.choices.map((choice) => `${choice.label}${choice.selected ? '✓' : ''}`)])).toEqual(expected);
  });

  it('targets a workspace or a space', () => {
    const [mine, acme] = switcherSections({ workspaces, teams, offered: true, context: personal });
    expect(mine.choices[0].target).toEqual({ kind: 'personal', workspaceId: 'w1' });
    expect(acme.choices[1].target).toEqual({ kind: 'space', spaceId: 's2' });
    expect(acme.choices[1].space?.name).toBe('Growth');
  });

  it.each<[ActiveContext, string | undefined, ReturnType<typeof switcherLabel>]>([
    [inSpace, 'Home', { title: 'Design', subtitle: 'Acme' }],
    [personal, 'Side', { title: 'Side' }],
    [personal, undefined, { title: 'Choose workspace' }],
    [{ kind: 'pending' }, 'Home', { title: 'Home' }],
  ])('label %#', (context, name, expected) => { expect(switcherLabel(context, name)).toEqual(expected); });
});

describe('space drawer', () => {
  const items = (sessions: SpaceSessionRow[], tasks: SpaceTaskRow[] = [], hidden = 0): SpaceItems =>
    ({ sessions: { items: sessions, hiddenCount: hidden }, tasks: { items: tasks, hiddenCount: 0 } });
  const input = (patch: Partial<SpaceDrawerInput> = {}): SpaceDrawerInput => ({ items: items([]), failed: false, owned: new Map(),
    presence: undefined, self: 'me', query: '', collapsedGroups: new Set(), collapsedThreads: new Set(), ...patch });
  const shape = (entries: SpaceDrawerEntry[]) => entries.map((entry) => {
    switch (entry.type) {
      case 'heading': return `# ${entry.title}`;
      case 'group': return `${entry.expanded ? 'v' : '>'} ${entry.repo}${entry.hidden ? ` (${entry.hidden})` : ''}`;
      case 'thread': return `T ${entry.row.id}${entry.childCount ? ` [${entry.childCount}]` : ''}`;
      case 'row': return `${entry.indent ? '  ' : ''}- ${entry.row.id}`;
      case 'task': return `K ${entry.task.id}`;
      case 'notice': return `! ${entry.text}`;
      case 'loading': return '...';
    }
  });
  const rows = [
    row({ id: 'old', createdAt: '2026-11-01T00:00:00Z', repoFullName: 'acme/web' }),
    row({ id: 'run', running: true, createdAt: '2026-11-02T00:00:00Z' }),
    row({ id: 'seen', createdAt: '2026-11-03T00:00:00Z', repoFullName: 'acme/web' }),
    row({ id: 'new', createdAt: '2026-11-04T00:00:00Z', creator: { userId: 'u3', githubLogin: 'cara', avatarUrl: null } }),
    row({ id: 'gone', archivedAt: '2026-11-05T00:00:00Z' }),
    row({ id: 'th', kind: 'thread', repoFullName: '', createdAt: '2026-11-06T00:00:00Z', title: 'Plan' }),
    row({ id: 'child', threadId: 'th', createdAt: '2026-11-07T00:00:00Z', repoFullName: 'acme/api' }),
  ];
  const presence = [viewer({ sessionId: 'seen' }), viewer({ userId: 'me', sessionId: 'old' }), viewer({ sessionId: 'new', state: 'away' })];

  it.each<[string, Partial<SpaceDrawerInput>, string[]]>([
    ['loading', { items: undefined }, ['...']],
    ['failed', { items: undefined, failed: true }, ['! Could not load the sessions.']],
    ['empty', {}, ['! No sessions in this space yet.']],
    ['threads, active, then by repository', { items: items(rows, [task()], 2), presence }, [
      '# Threads', 'T th [1]', '  - child', '# Sessions', `v ${ACTIVE_GROUP}`, '- seen', '- run',
      'v acme/api', '- child', 'v acme/app', '- new', 'v acme/web', '- old', '# Tasks', 'K k1', "! 2 items you can't see"]],
    ['collapsed group and thread', { items: items(rows), presence, collapsedGroups: new Set(['acme/web']), collapsedThreads: new Set(['th']) }, [
      '# Threads', 'T th [1]', '# Sessions', `v ${ACTIVE_GROUP}`, '- seen', '- run', 'v acme/api', '- child', 'v acme/app', '- new', '> acme/web (1)']],
    ['search by creator', { items: items(rows), query: ' CARA ' }, ['# Sessions', 'v acme/app', '- new']],
    ['search keeps a thread for its child', { items: items(rows), query: 'acme/api', collapsedThreads: new Set(['th']) },
      ['# Threads', 'T th [1]', '  - child', '# Sessions', 'v acme/api', '- child']],
    ['search filters tasks', { items: items(rows, [task(), task({ id: 'k2', title: 'Other', repoFullName: null })]), query: 'fix' }, ['# Tasks', 'K k1']],
    ['search with no match', { items: items(rows), query: 'zzz' }, ['! No sessions or threads match.']],
    ['hidden note alone', { items: items([], [], 1) }, ['! No sessions in this space yet.', "! 1 item you can't see"]],
  ])('%s', (_name, patch, expected) => { expect(shape(spaceDrawerEntries(input(patch)))).toEqual(expected); });

  it('drops a row that I archived even when the space row is stale', () => {
    const owned = new Map([['old', session({ id: 'old', archivedAt: '2026-11-09T00:00:00Z' })]]);
    expect(shape(spaceDrawerEntries(input({ items: items([rows[0]]), owned })))).toEqual(['! No sessions in this space yet.']);
  });

  it('lists teammates with the row open, not me', () => {
    const entries = spaceDrawerEntries(input({ items: items(rows), presence }));
    const seen = entries.find((entry) => entry.type === 'row' && entry.row.id === 'seen');
    const old = entries.find((entry) => entry.type === 'row' && entry.row.id === 'old');
    expect(seen?.type === 'row' && seen.viewers.map((member) => member.githubLogin)).toEqual(['ben']);
    expect(old?.type === 'row' && old.viewers).toEqual([]);
  });

  it.each<[string, SpaceSessionRow, Map<string, ReturnType<typeof session>>, string]>([
    ['space row', row(), new Map(), 'idle'],
    ['running space row', row({ running: true }), new Map(), 'working'],
    ['mine from the store', row(), new Map([['r1', session({ id: 'r1', chats: [] , status: 'error' })]]), 'failed'],
    ['running is never idle', row({ running: true }), new Map([['r1', session({ id: 'r1', chats: [] })]]), 'working'],
  ])('row state: %s', (_name, value, owned, kind) => { expect(spaceRowState(value, owned).kind).toBe(kind); });

  it.each([['idle', false], ['merged', false], ['closed', false], ['working', true], ['needs_reply', true]] as const)('active %s', (kind, active) => {
    expect(isActiveState({ kind, label: '' })).toBe(active);
  });
});

describe('open target with my workspaces', () => {
  it.each([
    ['in the selected workspace', 'w1', { kind: 'route', href: { pathname: '/sessions/[id]', params: { id: 'r1' } } }],
    ['in another of mine', 'w2', { kind: 'switch', workspaceId: 'w2', href: { pathname: '/sessions/[id]', params: { id: 'r1' } } }],
    ["a teammate's", 'w9', { kind: 'web', path: '/s/r1' }],
  ])('%s', (_name, workspaceId, expected) => {
    expect(openTarget(row({ workspaceId }), 'w1', ['w1', 'w2'])).toEqual(expected);
  });
});

describe('new work in a space', () => {
  const form = (patch: Partial<NewWorkForm> = {}): NewWorkForm => ({ mode: 'session', prompt: ' Fix it ', repository: { id: 'acme/app', fullName: 'acme/app' },
    agent: 'claude', model: 'claude-sonnet', baseBranch: 'ignored', internetAccess: false, ...patch });
  const sandbox = { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: true } } };

  const pr: NewWorkPullRequest = { id: 'pr-1', repositoryId: 'acme/app', number: 7, title: 'Fix', headBranch: 'tom/fix', baseBranch: 'develop' };
  const base = { repoFullName: 'acme/app', agent: 'claude', model: 'claude-sonnet', internetAccess: false, autoCreatePr: true } as const;

  it.each<[string, NewWorkForm, boolean, ReturnType<typeof spaceCreateBody>]>([
    ['session with a typed base branch', form({ baseBranch: ' release ' }), false, { ...base, prompt: 'Fix it', baseBranch: 'release' }],
    ['session with no base branch', form({ baseBranch: '' }), false, { ...base, prompt: 'Fix it', baseBranch: undefined }],
    ['blank base branch is left out', form({ baseBranch: '  ' }), false, { ...base, prompt: 'Fix it', baseBranch: undefined }],
    ['thread takes no repository or branch', form({ mode: 'thread', internetAccess: true, baseBranch: 'x', pullRequest: pr }), false,
      { kind: 'thread', agent: 'claude', model: 'claude-sonnet', prompt: 'Fix it', internetAccess: true }],
    ['empty prompt is left out', form({ prompt: '  ', baseBranch: '' }), false, { ...base, prompt: undefined, baseBranch: undefined }],
    ['pull request sets branch, id and its base', form({ baseBranch: '', pullRequest: pr }), false,
      { ...base, prompt: 'Fix it', baseBranch: 'develop', branch: 'tom/fix', fromPullRequestId: 'pr-1' }],
    ['typed base branch wins over the pull request base', form({ baseBranch: 'release', pullRequest: pr }), false,
      { ...base, prompt: 'Fix it', baseBranch: 'release', branch: 'tom/fix', fromPullRequestId: 'pr-1' }],
    ['pull request with no head or base branch', form({ baseBranch: '', pullRequest: { ...pr, headBranch: '', baseBranch: '' } }), false,
      { ...base, prompt: 'Fix it', baseBranch: undefined, branch: undefined, fromPullRequestId: 'pr-1' }],
    ['pull request of another repository is ignored', form({ baseBranch: '', pullRequest: { ...pr, repositoryId: 'acme/other' } }), false,
      { ...base, prompt: 'Fix it', baseBranch: undefined }],
    ['images: no prompt, naming text', form({ baseBranch: '' }), true, { ...base, prompt: undefined, namingText: 'Fix it', baseBranch: undefined }],
    ['images with empty text', form({ prompt: ' ', baseBranch: '' }), true, { ...base, prompt: undefined, namingText: undefined, baseBranch: undefined }],
    ['thread with images: naming text only', form({ mode: 'thread', internetAccess: true }), true,
      { kind: 'thread', agent: 'claude', model: 'claude-sonnet', prompt: undefined, namingText: 'Fix it', internetAccess: true }],
    ['images with a pull request', form({ baseBranch: '', pullRequest: pr }), true,
      { ...base, prompt: undefined, namingText: 'Fix it', baseBranch: 'develop', branch: 'tom/fix', fromPullRequestId: 'pr-1' }],
  ])('body: %s', (_name, value, withImages, expected) => {
    expect(spaceCreateBody(value, withImages)).toEqual(expected);
  });

  it.each<[string, NewWorkForm, boolean, string[]]>([
    ['thread', form({ mode: 'thread', baseBranch: 'x', pullRequest: pr }), false, ['branch', 'baseBranch', 'fromPullRequestId', 'repoFullName', 'autoCreatePr']],
    ['thread with images', form({ mode: 'thread', baseBranch: 'x', pullRequest: pr }), true, ['branch', 'baseBranch', 'fromPullRequestId', 'repoFullName', 'autoCreatePr']],
    ['session without a pull request', form(), false, ['branch', 'fromPullRequestId']],
  ])('body keys left out: %s', (_name, value, withImages, absent) => {
    const body = spaceCreateBody(value, withImages) as unknown as Record<string, unknown>;
    for (const key of absent) expect(body[key]).toBeUndefined();
  });

  it('refuses a session body with no repository', () => {
    expect(() => spaceCreateBody(form({ repository: null }))).toThrow('Choose a repository.');
    expect(() => spaceCreateBody(form({ repository: null }), true)).toThrow('Choose a repository.');
  });

  it('maps pull request rows to space repository ids and drops other rows', () => {
    const prRow = (patch: Record<string, unknown>) => ({ id: 'p', owner: 'Acme', repo: 'App', repositoryId: 'w-repo', ...patch });
    const repos = [{ id: 'acme/app', fullName: 'acme/app' }];
    expect(spacePullRequestRows([prRow({}), prRow({ id: 'q', repo: 'other' })], repos)).toEqual([prRow({ repositoryId: 'acme/app' })]);
    expect(spacePullRequestRows(undefined, repos)).toEqual([]);
    expect(spacePullRequestRows([prRow({})], [])).toEqual([]);
  });

  it.each<[string, NewWorkForm, string | null, string | null]>([
    ['no home workspace', form(), null, 'You need a workspace of your own to start a session in a space.'],
    ['no home workspace, thread', form({ mode: 'thread' }), null, 'You need a workspace of your own to start a thread in a space.'],
    ['no repository', form({ repository: null }), 'w1', 'Choose a repository.'],
    ['no prompt', form({ prompt: '' }), 'w1', 'Describe a task.'],
    ['ready', form(), 'w1', null],
  ])('blocked: %s', (_name, value, home, expected) => {
    expect(spaceBlockedReason(value, { homeWorkspaceId: home }, sandbox, false)).toBe(expected);
  });

  const home = { name: 'Home', repos: [{ id: 'x', name: 'Acme/App', url: '', defaultBranch: 'main' }] };
  it.each<[Parameters<typeof addsRepositoryNote>, string | null]>([
    [['session', 'acme/app', home], null],
    [['session', 'acme/other', home], 'Adds acme/other to Home'],
    [['thread', 'acme/other', home], null],
    [['session', undefined, home], null],
    [['session', 'acme/other', null], null],
  ])('adds repository %#', (args, expected) => { expect(addsRepositoryNote(...args)).toBe(expected); });

  it('maps space repositories by full name', () => {
    expect(spaceRepositories('s1', [{ spaceId: 's1', repoFullName: 'acme/app', githubRepoId: 1, createdAt: '' }])).toEqual([
      { id: 'acme/app', workspaceId: 's1', owner: 'acme', repo: 'app', fullName: 'acme/app', defaultBranch: '' }]);
    expect(spaceRepositories('s1', undefined)).toEqual([]);
  });

  it.each([
    ['same case', 'acme/app', 'main'],
    ['other case', 'Acme/App', 'main'],
    ['not in home', 'acme/other', ''],
  ])('default branch from home: %s', (_name, homeName, expected) => {
    const [result] = spaceRepositories('s1', [{ spaceId: 's1', repoFullName: 'acme/app', githubRepoId: 1, createdAt: '' }],
      [{ name: homeName, defaultBranch: 'main' }]);
    expect(result?.defaultBranch).toBe(expected);
  });

  it.each([
    ['session', 'Start a session in Design. Your teammates can see it.'],
    ['thread', 'Start a thread in Design. It can work across repositories. Only you can see it.'],
  ] as const)('placeholder %s', (mode, text) => { expect(spacePlaceholder(mode, 'Design')).toBe(text); });

  it.each<[string, Parameters<typeof composerChips>, string[]]>([
    ['session with a repository', ['session', { id: 'r' }], ['repository', 'branch', 'internet']],
    ['session without a repository', ['session', null], ['repository', 'internet']],
    ['thread', ['thread', { id: 'r' }], ['internet']],
  ])('a space composer has the personal chips: %s', (_name, args, expected) => {
    expect(composerChips(...args).context).toEqual(expected);
  });
});

describe('Personal leaves out items in a space', () => {
  const teams = [team()];
  it.each<[string, string | null | undefined, SpacesTeam[] | null, boolean, boolean]>([
    ['no space', null, teams, true, true],
    ['space field absent', undefined, teams, true, true],
    ['in one of my spaces', 's1', teams, true, false],
    ['spaces off', 's1', teams, false, true],
    ['space gone', 'gone', teams, true, true],
    ['teams loading', 's1', null, true, false],
    ['teams loading, no space', null, null, true, true],
    ['no teams', 's1', [], true, true],
  ])('%s', (_name, spaceId, value, offered, shown) => {
    expect(inPersonalList({ spaceId }, value, offered)).toBe(shown);
  });

  it('filters a list and keeps a loading list undefined', () => {
    const items = [session({ id: 'a' }), session({ id: 'b', spaceId: 's1' }), session({ id: 'c', spaceId: 'gone' })];
    expect(personalItems(items, teams, true)?.map((item) => item.id)).toEqual(['a', 'c']);
    expect(personalItems(undefined, teams, true)).toBeUndefined();
  });
});
