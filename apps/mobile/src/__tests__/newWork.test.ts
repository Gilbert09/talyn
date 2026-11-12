import type { WorkbenchReadiness } from '@talyn/shared';

import { agentChoice, agentForModel, blockedReason, branchSuggestions, chipLabel, composerChips, createInput, defaultRepositoryId,
  effectiveBranch, filterBranches, filterRepositories, forgetLastRepositories, internetMessage, lastRepositoryKey, loadLastRepository, modelFor, modelSections, modelsFor, rememberRepository,
  sandboxChoice, sendState, usableAgent, type ChipState, type ComposerChip, type NewWorkForm } from '../features/create/model';

const mockStorage = { getItem: jest.fn(async (_key: string): Promise<string | null> => null), setItem: jest.fn(async (_key: string, _value: string) => {}) };
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: mockStorage }));
beforeEach(() => { forgetLastRepositories(); mockStorage.getItem.mockReset().mockResolvedValue(null); mockStorage.setItem.mockReset().mockResolvedValue(); });

type Sandbox = WorkbenchReadiness['sandbox'];
const ready: Sandbox = { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: true } } };
const codexOff: Sandbox = { ok: true, reasons: [], agents: { claude: { ok: true },
  codex: { ok: false, reason: { code: 'agent_not_connected', message: 'Connect Codex in Settings.' } } } };
const claudeReauth: Sandbox = { ok: true, reasons: [], agents: { claude: { ok: false, reason: { code: 'agent_reauth_required', message: 'Sign in to Claude again.' } },
  codex: { ok: true } } };
const down: Sandbox = { ok: false, reasons: [{ code: 'fleet_disabled', message: 'Sessions are paused.' }], agents: { claude: { ok: true }, codex: { ok: true } } };
const form = (patch: Partial<NewWorkForm> = {}): NewWorkForm => ({ mode: 'session', prompt: 'Fix the bug', repository: { id: 'repo-one', fullName: 'a/b' },
  agent: 'claude', model: 'claude-sonnet-5-5', baseBranch: '', internetAccess: true, ...patch });

describe('agent readiness', () => {
  it.each([
    [null, 'claude', { available: false, reason: 'Checking cloud availability' }],
    [ready, 'codex', { available: true }],
    [codexOff, 'codex', { available: false, reason: 'Connect Codex in Settings.', connect: 'connect' }],
    [claudeReauth, 'claude', { available: false, reason: 'Sign in to Claude again.', connect: 'reauth' }],
    [down, 'claude', { available: false, reason: 'Sessions are paused.' }],
  ] as const)('%j %s', (sandbox, agent, expected) => expect(agentChoice(sandbox, agent)).toEqual(expected));
  it.each([
    [ready, true], [codexOff, true], [down, false], [null, false],
  ] as const)('sandbox choice for %j is %s', (sandbox, available) => expect(sandboxChoice(sandbox).available).toBe(available));
  it.each([
    [ready, 'codex', 'codex'], [codexOff, 'codex', 'claude'], [claudeReauth, 'claude', 'codex'], [down, 'codex', 'codex'],
  ] as const)('usable agent with %j wanting %s is %s', (sandbox, wanted, expected) => expect(usableAgent(sandbox, wanted)).toBe(expected));
  it('reads the workspace model per agent and filters the catalogue by vendor', () => {
    expect(modelFor({ fleetModels: { codex: 'gpt-6-luna' } } as never, 'codex')).toBe('gpt-6-luna');
    expect(modelFor({ fleetModels: { codex: 'claude-opus-5' } } as never, 'codex')).toBe('gpt-6.1-terra');
    expect(modelFor(undefined, 'claude')).toBe('claude-sonnet-5-5');
    expect(modelsFor('codex').every((model) => model.provider === 'openai')).toBe(true);
  });
});

describe('start validation', () => {
  it.each<[string, Partial<NewWorkForm>, WorkbenchReadiness['sandbox'] | null, boolean, string | null]>([
    ['a ready session', {}, ready, false, null],
    ['a ready thread without a repository', { mode: 'thread', repository: null }, ready, false, null],
    ['a session without a repository', { repository: null }, ready, false, 'Choose a repository.'],
    ['an unavailable sandbox', {}, down, false, 'Sessions are paused.'],
    ['readiness still loading', {}, null, false, 'Checking cloud availability'],
    ['an agent that is not connected', { agent: 'codex' }, codexOff, false, 'Connect Codex in Settings.'],
    ['no connection', {}, ready, true, 'You are offline.'],
    ['an empty session prompt', { prompt: '   ' }, ready, false, 'Describe a task.'],
    ['an empty thread prompt', { mode: 'thread', prompt: '' }, ready, false, 'Describe what you want to get done.'],
  ])('%s', (_name, patch, sandbox, offline, expected) => expect(blockedReason(form(patch), sandbox, offline)).toBe(expected));
  it.each<[string, Partial<NewWorkForm>, object]>([
    ['a session', { baseBranch: ' develop ' }, { workspaceId: 'one', repositoryId: 'repo-one', runtime: 'sandbox', agent: 'claude',
      model: 'claude-sonnet-5-5', baseBranch: 'develop', prompt: 'Fix the bug', internetAccess: true, autoCreatePr: true }],
    ['a session on the default branch', {}, { baseBranch: undefined }],
    ['a thread', { mode: 'thread', repository: null, internetAccess: false }, { workspaceId: 'one', kind: 'thread', runtime: 'sandbox',
      agent: 'claude', model: 'claude-sonnet-5-5', prompt: 'Fix the bug', internetAccess: false }],
  ])('builds the request for %s', (_name, patch, expected) => expect(createInput(form(patch), 'one')).toMatchObject(expected));
  it('refuses a session without a repository', () => expect(() => createInput(form({ repository: null }), 'one')).toThrow('Choose a repository.'));
  it.each<[string, Partial<NewWorkForm>, boolean, object]>([
    ['a session with images', {}, true, { prompt: undefined, namingText: 'Fix the bug', repositoryId: 'repo-one' }],
    ['a thread with images', { mode: 'thread', repository: null }, true, { prompt: undefined, namingText: 'Fix the bug', kind: 'thread' }],
    ['a session without images', {}, false, { prompt: 'Fix the bug', namingText: undefined }],
    ['a thread without images', { mode: 'thread', repository: null }, false, { prompt: 'Fix the bug', namingText: undefined }],
    ['an empty prompt with images', { prompt: '  ' }, true, { prompt: undefined, namingText: undefined }],
  ])('names %s from the prompt only when the message goes later', (_name, patch, withImages, expected) =>
    expect(createInput(form(patch), 'one', withImages)).toMatchObject(expected));
  it('prefers the last repository while it is still watched', () => {
    const repos = [{ id: 'a' }, { id: 'b' }];
    expect(defaultRepositoryId('ws-default', repos)).toBe('a');
    rememberRepository('ws-default', 'b');
    expect(defaultRepositoryId('ws-default', repos)).toBe('b');
    expect(defaultRepositoryId('ws-default', [{ id: 'a' }])).toBe('a');
    expect(defaultRepositoryId('ws-default', [])).toBe('');
    expect(mockStorage.setItem).toHaveBeenCalledWith('ws-default', 'b');
  });
  it.each([
    ['nothing saved', null, null],
    ['a saved repository', 'b', 'b'],
  ])('loads %s from the device', async (_name, saved, expected) => {
    mockStorage.getItem.mockResolvedValue(saved);
    await expect(loadLastRepository('space:s1')).resolves.toBe(expected);
    expect(mockStorage.getItem).toHaveBeenCalledWith('space:s1');
    expect(defaultRepositoryId('space:s1', [{ id: 'a' }, { id: 'b' }])).toBe(expected ?? 'a');
  });
  it.each([
    ['a workspace', 'user-one', 'ws-1', 'talyn.new-work-repo.user-one.ws-1'],
    ['a space', 'user-one', 'space:s1', 'talyn.new-work-repo.user-one.space%3As1'],
    ['an id with a slash', 'a/b', 'ws-1', 'talyn.new-work-repo.a%2Fb.ws-1'],
  ])('keys the saved repository by user and %s', (_name, user, place, key) => expect(lastRepositoryKey(user, place)).toBe(key));
  it('reads the device once per run and prefers a start made during the read', async () => {
    let resolve: (value: string | null) => void = () => {};
    mockStorage.getItem.mockReturnValue(new Promise((done) => { resolve = done; }));
    const loading = loadLastRepository('ws');
    rememberRepository('ws', 'new');
    resolve('old');
    await expect(loading).resolves.toBe('new');
    await expect(loadLastRepository('ws')).resolves.toBe('new');
    expect(mockStorage.getItem).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['a failed read', () => mockStorage.getItem.mockRejectedValue(new Error('disk'))],
    ['a failed write', () => mockStorage.setItem.mockRejectedValue(new Error('disk'))],
  ])('ignores %s', async (_name, fail) => {
    fail();
    rememberRepository('other', 'x');
    forgetLastRepositories();
    await expect(loadLastRepository('ws')).resolves.toBeNull();
  });
});

describe('composer controls', () => {
  const chipState = (patch: Partial<ChipState> = {}): ChipState => ({ mode: 'session', repository: { fullName: 'PostHog/posthog' },
    branch: 'master', internetAccess: true, agent: 'claude', model: 'claude-opus-5-5', ...patch });

  it.each<[string, Parameters<typeof composerChips>, ComposerChip[]]>([
    ['a session with a repository', ['session', { id: 'a' }], ['repository', 'branch', 'internet']],
    ['a session without a repository', ['session', null], ['repository', 'internet']],
    ['a thread', ['thread', { id: 'a' }], ['internet']],
    ['a thread without a repository', ['thread', null], ['internet']],
  ])('shows the context chips for %s', (_name, args, expected) => {
    expect(composerChips(...args)).toEqual({ context: expected, card: ['mode', 'model'] });
  });

  it.each<[ComposerChip, Partial<ChipState>, string, string]>([
    ['mode', {}, 'Session', 'Start a session. Change what to start'],
    ['mode', { mode: 'thread' }, 'Thread', 'Start a thread. Change what to start'],
    ['repository', {}, 'PostHog/posthog', 'Repository: PostHog/posthog. Change repository'],
    ['repository', { repository: null }, 'Repository', 'Repository: none. Choose a repository'],
    ['repository', { repository: null, repositoriesLoading: true }, 'Loading', 'Repositories are loading'],
    ['branch', {}, 'master', 'Base branch: master. Change base branch'],
    ['internet', {}, 'Internet on', 'Internet access'],
    ['internet', { internetAccess: false }, 'Internet off', 'Internet access'],
    ['model', {}, 'Opus 5.5', 'Model: Opus 5.5, Claude. Change model'],
    ['model', { agent: 'codex', model: 'gpt-6-luna' }, 'GPT-6 Luna', 'Model: GPT-6 Luna, Codex. Change model'],
  ])('labels the %s chip with %j', (chip, patch, text, accessibilityLabel) =>
    expect(chipLabel(chip, chipState(patch))).toEqual({ text, accessibilityLabel }));

  it.each<[string, { defaultBranch: string } | null, string]>([
    [' develop ', { defaultBranch: 'master' }, 'develop'],
    ['', { defaultBranch: 'master' }, 'master'],
    ['  ', { defaultBranch: '' }, 'main'],
    ['', null, 'main'],
  ])('uses %j on %j as %s', (typed, repository, expected) => expect(effectiveBranch(typed, repository)).toBe(expected));

  it.each<[string, string | null, boolean, string, { enabled: boolean; hint?: string }]>([
    ['ready', null, false, 'one', { enabled: true }],
    ['starting', null, true, 'one', { enabled: false, hint: 'Starting.' }],
    ['no workspace', null, false, '', { enabled: false, hint: 'Choose a workspace.' }],
    ['blocked', 'Describe a task.', false, 'one', { enabled: false, hint: 'Describe a task.' }],
    ['blocked while starting', 'Describe a task.', true, 'one', { enabled: false, hint: 'Starting.' }],
  ])('send is %s', (_name, blocked, busy, workspaceId, expected) => expect(sendState(blocked, busy, workspaceId)).toEqual(expected));

  it.each([[true, 'Internet access on.'], [false, 'Internet access off. The agent can reach the repository only.']])(
    'announces internet %s', (on, expected) => expect(internetMessage(on)).toBe(expected));

  it.each([
    ['claude-opus-5-5', 'claude'], ['gpt-6-luna', 'codex'], ['gpt-6.1-terra', 'codex'], ['not-a-model', null],
  ])('the agent for %s is %s', (model, expected) => expect(agentForModel(model)).toBe(expected));

  // Counts come from the shared catalog, so adding a model does not break these cases.
  const CLAUDE_MODELS = modelsFor('claude').length;
  const CODEX_MODELS = modelsFor('codex').length;
  it.each<[string, WorkbenchReadiness['sandbox'] | null, 'claude' | 'codex', Array<[string, number, string | undefined]>]>([
    ['both agents ready', ready, 'claude', [['claude', CLAUDE_MODELS, undefined], ['codex', CODEX_MODELS, undefined]]],
    ['Codex not connected', codexOff, 'claude', [['claude', CLAUDE_MODELS, undefined], ['codex', 0, 'Codex is not connected to this workspace, so Codex models cannot run.']]],
    ['Claude needs a sign-in', claudeReauth, 'codex', [['claude', 0, 'The Claude sign-in for this workspace has expired, so Claude models cannot run.'], ['codex', CODEX_MODELS, undefined]]],
    ['the sandbox down', down, 'claude', [['claude', CLAUDE_MODELS, undefined]]],
    ['readiness loading', null, 'codex', [['codex', CODEX_MODELS, undefined]]],
  ])('model sections with %s', (_name, sandbox, current, expected) => {
    expect(modelSections(sandbox, current).map((section) => [section.agent, section.models.length, section.note])).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    ['nothing typed', '', ['PostHog/posthog', 'PostHog/charts', 'Other/tool']],
    ['part of a name', 'post', ['PostHog/posthog', 'PostHog/charts']],
    ['the owner, in any case', 'OTHER', ['Other/tool']],
    ['no match', 'zzz', []],
  ])('filters repositories by %s', (_name, query, expected) => {
    const repos = [{ fullName: 'PostHog/posthog' }, { fullName: 'PostHog/charts' }, { fullName: 'Other/tool' }];
    expect(filterRepositories(repos, query).map((repo) => repo.fullName)).toEqual(expected);
  });

  it('suggests the default branch, then open pull request bases with own ones first', () => {
    const row = (number: number, baseBranch: string, patch: object = {}) => ({ state: 'open', repositoryId: 'r', number, authored: false, summary: { baseBranch }, ...patch });
    const rows = [row(1, 'release'), row(5, 'staging'), row(2, 'hotfix', { authored: true }), row(9, 'other', { repositoryId: 'x' }),
      row(7, 'closed', { state: 'closed' }), row(3, 'master')];
    expect(branchSuggestions({ id: 'r', defaultBranch: 'master' }, rows)).toEqual(['master', 'hotfix', 'staging', 'release']);
    expect(branchSuggestions({ id: 'r', defaultBranch: 'master' })).toEqual(['master']);
    expect(branchSuggestions(null, rows)).toEqual([]);
  });

  it.each([
    ['', ['master', 'staging', 'release']], ['sta', ['staging']], ['MAS', ['master']], ['new-branch', []],
  ])('filters branch suggestions by %j', (typed, expected) => expect(filterBranches(['master', 'staging', 'release'], typed)).toEqual(expected));
});
