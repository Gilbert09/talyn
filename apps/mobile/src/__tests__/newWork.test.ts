import type { WorkbenchReadiness } from '@talyn/shared';

import { agentChoice, blockedReason, createInput, defaultRepositoryId, modelFor, modelsFor, rememberRepository, sandboxChoice, usableAgent,
  type NewWorkForm } from '../features/create/model';

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
  it('prefers the last repository while it is still watched', () => {
    const repos = [{ id: 'a' }, { id: 'b' }];
    expect(defaultRepositoryId('ws-default', repos)).toBe('a');
    rememberRepository('ws-default', 'b');
    expect(defaultRepositoryId('ws-default', repos)).toBe('b');
    expect(defaultRepositoryId('ws-default', [{ id: 'a' }])).toBe('a');
    expect(defaultRepositoryId('ws-default', [])).toBe('');
  });
});
