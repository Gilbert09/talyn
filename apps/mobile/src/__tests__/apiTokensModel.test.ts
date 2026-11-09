import {
  ALL_WORKSPACES, DEFAULT_EXPIRY, EXPIRY_OPTIONS, NO_EXPIRY, accessHint, canCreate, createRequest, curlExample, expiry, fullAccessLevels,
  levelsFor, readOnlyLevels, relativeTime, resourcesFor, scopeChips, scopesFor, tokensView, usageLine, workspaceLabel,
  type Levels, type TokenDraft,
} from '../features/apiTokens/model';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const DAY = 86_400_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const NONE: Levels = { workspaces: 'none', teams: 'none', spaces: 'none', repositories: 'none', sessions: 'none' };

describe('the form choices', () => {
  it('offers web expiry choices with 90 days by default', () => {
    expect(EXPIRY_OPTIONS.map((option) => option.label)).toEqual(['30 days', '90 days', '1 year', 'No expiry']);
    expect(DEFAULT_EXPIRY).toBe('90');
  });

  it.each([
    [false, ['workspaces', 'repositories', 'sessions']],
    [true, ['workspaces', 'teams', 'spaces', 'repositories', 'sessions']],
  ])('resources with spaces offered %s', (offered, expected) => {
    expect(resourcesFor(offered).map((resource) => resource.key)).toEqual(expected);
  });

  it.each([
    ['workspaces', ['none', 'read']],
    ['teams', ['none', 'read']],
    ['spaces', ['none', 'read', 'write']],
    ['repositories', ['none', 'read', 'write']],
    ['sessions', ['none', 'read', 'write']],
  ] as const)('levels for %s', (resource, expected) => {
    expect(levelsFor(resource)).toEqual(expected);
  });

  it.each([
    ['sessions', 'none', 'No access'],
    ['sessions', 'read', 'Read sessions, chats and transcripts'],
    ['sessions', 'write', 'Read sessions, chats and transcripts. Start sessions and send messages.'],
    ['workspaces', 'read', 'Read workspaces'],
    ['spaces', 'write', 'Read team spaces and their sessions. Start sessions in team spaces.'],
  ] as const)('hint for %s at %s', (resource, level, expected) => {
    expect(accessHint(resource, level)).toBe(expected);
  });
});

describe('scopesFor', () => {
  it.each([
    ['read only', readOnlyLevels(false), false, ['workspaces:read', 'repositories:read', 'sessions:read']],
    ['full access', fullAccessLevels(false), false, ['workspaces:read', 'repositories:read', 'sessions:read', 'sessions:write']],
    ['read only with spaces', readOnlyLevels(true), true, ['workspaces:read', 'teams:read', 'spaces:read', 'repositories:read', 'sessions:read']],
    ['full access with spaces', fullAccessLevels(true), true,
      ['workspaces:read', 'teams:read', 'spaces:read', 'spaces:write', 'repositories:read', 'sessions:read', 'sessions:write']],
    ['nothing', NONE, false, []],
    ['spaces levels left over when spaces are not offered', { ...NONE, spaces: 'write' }, false, []],
    ['repository write', { ...NONE, repositories: 'write' }, false, ['repositories:read', 'repositories:write']],
  ] as const)('%s', (_name, levels, offered, expected) => {
    expect(scopesFor(levels, offered)).toEqual(expected);
  });

  it('gives each preset a fresh object', () => {
    const levels = readOnlyLevels(false);
    levels.sessions = 'write';
    expect(readOnlyLevels(false).sessions).toBe('read');
  });
});

describe('scopeChips', () => {
  it.each([
    [['sessions:read', 'sessions:write', 'workspaces:read'], false, ['Workspaces: read', 'Sessions: read & write']],
    [['spaces:read', 'teams:read'], false, []],
    [['spaces:read', 'teams:read'], true, ['Teams: read', 'Spaces: read']],
    [['memory:read', 'pull_requests:write'], true, []],
    [[], false, []],
    [['repositories:write'], false, ['Repositories: read & write']],
  ])('%j with spaces %s', (scopes, offered, expected) => {
    expect(scopeChips(scopes, offered)).toEqual(expected);
  });
});

describe('relativeTime', () => {
  it.each([
    [0, 'just now'],
    [-30_000, 'just now'],
    [-60_000, '1 minute ago'],
    [-5 * 60_000, '5 minutes ago'],
    [3_600_000, 'in 1 hour'],
    [-2 * DAY, '2 days ago'],
    [3 * DAY, 'in 3 days'],
    [60 * DAY, 'in 2 months'],
    [-400 * DAY, '1 year ago'],
    [-800 * DAY, '2 years ago'],
  ])('%i ms', (offset, expected) => {
    expect(relativeTime(at(offset), NOW)).toBe(expected);
  });

  it('is empty for a bad date', () => {
    expect(relativeTime('not a date', NOW)).toBe('');
  });
});

describe('expiry', () => {
  it.each([
    [null, 'No expiry', 'normal'],
    [at(30 * DAY), 'Expires in 1 month', 'normal'],
    [at(8 * DAY), 'Expires in 8 days', 'normal'],
    [at(7 * DAY), 'Expires in 7 days', 'soon'],
    [at(3_600_000), 'Expires in 1 hour', 'soon'],
    [at(0), 'Expired just now', 'expired'],
    [at(-2 * DAY), 'Expired 2 days ago', 'expired'],
  ])('%s', (expiresAt, text, tone) => {
    expect(expiry({ expiresAt }, NOW)).toEqual({ text, tone });
  });
});

describe('usageLine and workspaceLabel', () => {
  it.each([
    [{ createdAt: at(-2 * DAY), lastUsedAt: null }, 'Created 2 days ago · Never used'],
    [{ createdAt: at(-2 * DAY), lastUsedAt: at(-5 * 60_000) }, 'Created 2 days ago · Last used 5 minutes ago'],
  ])('%j', (token, expected) => {
    expect(usageLine(token, NOW)).toBe(expected);
  });

  const workspaces = [{ id: 'w1', name: 'PostHog' }, { id: 'w2', name: 'Talyn' }];
  it.each([
    [null, 'All workspaces'],
    [['w1'], 'PostHog'],
    [['w1', 'w2'], 'PostHog, Talyn'],
    [['gone'], 'Unknown workspace'],
    [[], ''],
  ])('%j', (ids, expected) => {
    expect(workspaceLabel(ids, workspaces)).toBe(expected);
  });
});

describe('creating a token', () => {
  const draft = (overrides: Partial<TokenDraft> = {}): TokenDraft =>
    ({ name: 'CI script', expiry: DEFAULT_EXPIRY, workspaceId: ALL_WORKSPACES, levels: readOnlyLevels(false), ...overrides });

  it.each([
    ['a named token with access', draft(), false, true],
    ['an empty name', draft({ name: '' }), false, false],
    ['a name of spaces', draft({ name: '   ' }), false, false],
    ['no access', draft({ levels: NONE }), false, false],
    ['while creating', draft(), true, false],
  ])('%s', (_name, given, creating, expected) => {
    expect(canCreate(given, false, creating)).toBe(expected);
  });

  it.each([
    ['the defaults', draft({ name: '  CI script ' }), { name: 'CI script', workspaceIds: null, expiresInDays: 90 }],
    ['one workspace, one year', draft({ workspaceId: 'w1', expiry: '365' }), { workspaceIds: ['w1'], expiresInDays: 365 }],
    ['no expiry', draft({ expiry: NO_EXPIRY }), { expiresInDays: null }],
    ['30 days', draft({ expiry: '30' }), { expiresInDays: 30 }],
  ])('sends %s', (_name, given, expected) => {
    expect(createRequest(given, false)).toMatchObject({ ...expected, scopes: ['workspaces:read', 'repositories:read', 'sessions:read'] });
  });

  it('shows the curl command web shows', () => {
    expect(curlExample('talyn_pat_x')).toBe('curl https://api.talyn.dev/v1/me -H "Authorization: Bearer talyn_pat_x"');
  });
});

describe('tokensView', () => {
  it.each([
    ['loading tokens', 'loading' as const, undefined, false, 'loading'],
    ['a failed first read', true, undefined, true, 'error'],
    ['a failed read with the flag off', false, undefined, true, 'error'],
    ['features loading, no tokens', 'loading' as const, [], false, 'loading'],
    ['features loading, some tokens', 'loading' as const, [{}], false, 'list'],
    ['flag off, no tokens', false, [], false, 'unavailable'],
    ['flag off, old tokens to revoke', false, [{}], false, 'list'],
    ['flag on, no tokens', true, [], false, 'list'],
    ['flag on, tokens', true, [{}, {}], false, 'list'],
  ])('%s', (_name, features, tokens, failed, expected) => {
    expect(tokensView({ features, tokens, failed })).toBe(expected);
  });
});
