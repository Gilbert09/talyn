import { POSTHOG_INBOX_BACKLOG_STATE_LABELS, type PostHogInboxBacklogPage, type PostHogInboxBacklogRow, type PostHogInboxStatus, type WorkflowConditions, type WorkflowWithStats } from '@talyn/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { PostHogInboxScreen } from '../features/integrations/PostHogInboxScreen';
import { RuleDetailScreen } from '../features/integrations/RuleDetailScreen';
import { backlogRowText, backlogStateLabel, dailyCapText, manualRunText, postHogInboxCardView, postHogInboxConditionFacts, postHogInboxPushText, ruleIntegration } from '../features/integrations/model';

const mockRule = {
  id: 'r1', workspaceId: 'ws-1', integration: 'posthog_inbox', name: 'Fix urgent reports', enabled: true, events: ['report_ready'],
  conditions: { priorities: ['P0', 'P1'], scouts: { exclude: ['noisy'] }, minSignalCount: 3 },
  actions: [{ type: 'start_task', repositoryId: 'repo-1', prompt: 'Fix' }], maxRunsPerPrPerHour: 5, maxRunsPerDay: 10, createdAt: '', updatedAt: '',
  stats: { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null },
} as unknown as WorkflowWithStats;

const mockLifecycle = jest.requireActual<typeof import('./workflowFixtures')>('./workflowFixtures').fixture().lifecycle;
const mockInboxStatus = jest.fn();
const mockOpenExternal = jest.fn();
const mockBacklog = jest.fn();
const mockRuns = jest.fn(() => [] as unknown[]);

jest.mock('@talyn/client/native', () => {
  const actual = jest.requireActual('@talyn/client/native');
  return { ...actual, workflows: { ...actual.workflows, posthogInboxStatus: (...a: unknown[]) => mockInboxStatus(...a), posthogInboxBacklog: (...a: unknown[]) => mockBacklog(...a) } };
});
jest.mock('../auth/AuthProvider', () => ({
  useNetwork: () => 'online',
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'ws-1', choices: [] }),
}));
jest.mock('../features/automations/data', () => ({
  useWorkflowList: () => ({ status: 'ready', data: [mockRule], refresh: jest.fn(), refreshing: false }),
  useLoopList: () => ({ status: 'ready', data: undefined, refresh: jest.fn(), refreshing: false }),
  useRuns: () => ({ status: 'ready', data: mockRuns(), refresh: jest.fn(), refreshing: false }),
}));
jest.mock('../components/Workflow', () => ({
  ...jest.requireActual('../components/Workflow'),
  openExternal: (...a: unknown[]) => mockOpenExternal(...a),
}));
jest.mock('expo-router', () => ({ Stack: { Screen: () => null }, Link: ({ children }: { children: React.ReactNode }) => children }));

describe('PostHog Inbox rule model', () => {
  it('lists the rule integration', () => {
    expect(ruleIntegration('posthog_inbox')).toBe('posthog_inbox');
  });

  it.each([
    [{}, [{ label: 'Actionability', value: 'Ready to fix' }]],
    [null, [{ label: 'Actionability', value: 'Ready to fix' }]],
    [{ priorities: ['P0', 'P1'], actionability: ['requires_human_input', 'not_actionable'] } as WorkflowConditions,
      [{ label: 'Priority', value: 'P0, P1' }, { label: 'Actionability', value: 'Needs a person, Not actionable' }]],
    [{ scouts: { include: ['a'], exclude: ['b'] }, titleContains: ' crash ', minSignalCount: 2 } as WorkflowConditions,
      [{ label: 'Actionability', value: 'Ready to fix' }, { label: 'Scout', value: 'only a; not b' },
        { label: 'Title contains', value: '“crash”' }, { label: 'At least this many signals', value: '2' }]],
    [{ minSignalCount: 0, titleContains: '  ' } as WorkflowConditions, [{ label: 'Actionability', value: 'Ready to fix' }]],
  ])('describes conditions %j', (conditions, expected) => {
    const facts = postHogInboxConditionFacts(conditions);
    expect(facts.map(({ label, value }) => ({ label, value }))).toEqual(expect.arrayContaining(expected));
    expect(facts).toHaveLength(expected.length);
  });

  it.each<[string, { lastPushAt: string | null; pushConfigured: boolean; pushManaged?: boolean } | null, RegExp | null]>([
    ['no status yet', null, null],
    ['a managed URL without a push', { lastPushAt: null, pushConfigured: true, pushManaged: true }, /^Talyn set up the destination in PostHog\. Talyn has a webhook URL, but no push/],
    ['a managed URL with a recent push', { lastPushAt: new Date(Date.now() - 60_000).toISOString(), pushConfigured: true, pushManaged: true }, /^Talyn set up the destination in PostHog\. Last push from PostHog: .*every 30 minutes/],
    ['a managed URL with an old push', { lastPushAt: new Date(Date.now() - 25 * 3_600_000).toISOString(), pushConfigured: true, pushManaged: true }, /^Talyn set up the destination in PostHog\. .*No push in the last 24 hours/],
    ['no URL, whatever pushManaged says', { lastPushAt: null, pushConfigured: false, pushManaged: true }, /^PostHog does not push to Talyn yet/],
    ['a URL made by hand', { lastPushAt: null, pushConfigured: true, pushManaged: false }, /^Talyn has a webhook URL/],
    ['no URL', { lastPushAt: null, pushConfigured: false }, /does not push to Talyn yet\. Talyn checks the Inbox every 3 minutes/],
    ['a URL without a push', { lastPushAt: null, pushConfigured: true }, /no push from PostHog has arrived yet/],
    ['a push a minute ago', { lastPushAt: new Date(Date.now() - 60_000).toISOString(), pushConfigured: true }, /also checks the Inbox every 30 minutes/],
    ['a push 25 hours ago', { lastPushAt: new Date(Date.now() - 25 * 3_600_000).toISOString(), pushConfigured: true }, /No push in the last 24 hours/],
    ['a push time that is not a time', { lastPushAt: 'soon', pushConfigured: true }, /Last push from PostHog: never/],
  ])('words the push: %s', (_name, status, text) => {
    const line = postHogInboxPushText(status);
    if (text === null) expect(line).toBeNull();
    else expect(line).toMatch(text);
  });

  it.each([[10, '10 runs a day'], [1, '1 run a day'], [0, null], [null, null], [undefined, null]])('words the daily cap %s', (cap, text) => {
    expect(dailyCapText(cap)).toBe(text);
  });
});

describe('PostHog Inbox rule detail', () => {
  it('shows the conditions and daily cap read-only, with the web link', async () => {
    await render(<RuleDetailScreen kind="workflow" id="r1" integration="posthog_inbox" />);
    expect(await screen.findByText('Report ready for work')).toBeVisible();
    expect(screen.getByText('P0, P1')).toBeVisible();
    expect(screen.getByText('not noisy')).toBeVisible();
    expect(screen.getByText('10 runs a day')).toBeVisible();
    expect(screen.getByText('Edit on the web')).toBeVisible();
  });
});

const NOW = Date.parse('2026-11-16T12:00:00Z');
const status = (extra: Partial<PostHogInboxStatus> = {}): PostHogInboxStatus => ({
  access: 'ok', reason: null, authMethod: 'oauth', projectId: '42', host: 'https://us.posthog.com', connection: 'posthog_inbox',
  missingScopes: [], oauthAvailable: true, lastPolledAt: '2026-11-16T11:55:00Z', lastError: null, lastPushAt: null, pushConfigured: false, pushManaged: false, pushSetupMissingScopes: [], ...extra,
});

describe('PostHog Inbox connection card view', () => {
  it.each([
    ['ok via the Inbox connection', status(), 'Connected', 'success', true, 'Manage on the web'],
    ['ok via the PostHog Code fallback', status({ connection: 'posthog_code' }), 'Connected', 'success', true, 'Connect on the web'],
    ['personal API key, unchecked', status({ access: 'unknown', authMethod: 'personal_api_key', lastPolledAt: null }),
      'Connected — not checked yet', 'muted', true, 'Manage on the web'],
    ['reconnect', status({ access: 'reconnect', reason: 'PostHog revoked the grant.' }), 'Reconnect needed', 'warning', false, 'Reconnect on the web'],
    ['reconnect, Code fallback', status({ access: 'reconnect', connection: 'posthog_code' }), 'Reconnect needed', 'warning', false, 'Reconnect on the web'],
    ['not connected', status({ access: 'not_connected', authMethod: null, projectId: null, host: null, connection: null, lastPolledAt: null }),
      'Not connected', 'muted', false, 'Connect on the web'],
  ] as const)('maps %s', (_name, input, badge, tone, connected, webLabel) => {
    expect(postHogInboxCardView(input, NOW)).toMatchObject({ badge, tone, connected, webLabel });
  });

  it.each([
    [status({ access: 'reconnect', reason: 'Old grant.', missingScopes: ['inbox:read', 'project:read'] }),
      ['Old grant.', 'Missing permissions: inbox:read, project:read.']],
    [status({ access: 'reconnect', reason: null }), ['The PostHog connection does not have the Inbox permissions.']],
    [status({ access: 'reconnect', reason: '  ' }), ['The PostHog connection does not have the Inbox permissions.']],
    [status(), ['Last checked 5 minutes ago.']],
    [status({ lastPolledAt: null }), ['Not checked yet.']],
    [status({ lastError: 'Boom' }), ['Last checked 5 minutes ago.', 'The last check failed. Boom']],
    [status({ connection: 'posthog_code' }), [expect.stringContaining('older PostHog Code connection'), 'Last checked 5 minutes ago.']],
    [status({ access: 'unknown', authMethod: 'personal_api_key', lastPolledAt: null }),
      ['Talyn has not read your Inbox with this PostHog API key yet.', 'Not checked yet.']],
    [status({ access: 'not_connected', connection: null, lastPolledAt: null }), [expect.stringContaining('Until you connect PostHog')]],
  ])('words the notes for %j', (input, notes) => {
    expect(postHogInboxCardView(input, NOW).notes).toEqual(notes);
  });

  it.each([
    [status(), [{ label: 'Project', value: '42' }, { label: 'Host', value: 'https://us.posthog.com' }, { label: 'Sign-in', value: 'PostHog account' }]],
    [status({ authMethod: 'personal_api_key', host: null }), [{ label: 'Project', value: '42' }, { label: 'Sign-in', value: 'Personal API key' }]],
    [status({ projectId: null, host: null, authMethod: null }), []],
  ])('lists the facts for %j', (input, facts) => {
    expect(postHogInboxCardView(input, NOW).facts).toEqual(facts);
  });
});

describe('PostHog Inbox connection screen', () => {
  beforeEach(() => {
    mockInboxStatus.mockReset();
    mockOpenExternal.mockReset();
  });

  it.each([
    ['ok via the Inbox connection', status(), ['Connected', 'Project', '42', 'PostHog account'], 'Manage on the web'],
    ['ok via the Code fallback', status({ connection: 'posthog_code' }), ['Connected', /older PostHog Code connection/], 'Connect on the web'],
    ['unknown key', status({ access: 'unknown', authMethod: 'personal_api_key' }), ['Connected — not checked yet', 'Personal API key'], 'Manage on the web'],
    ['reconnect with scopes', status({ access: 'reconnect', reason: 'Grant too old.', missingScopes: ['inbox:read'] }),
      ['Reconnect needed', 'Grant too old.', 'Missing permissions: inbox:read.'], 'Reconnect on the web'],
    ['reconnect without scopes', status({ access: 'reconnect', reason: null }),
      ['Reconnect needed', 'The PostHog connection does not have the Inbox permissions.'], 'Reconnect on the web'],
    ['not connected', status({ access: 'not_connected', connection: null, authMethod: null, projectId: null, host: null }),
      ['Not connected', /Until you connect PostHog/], 'Connect on the web'],
  ])('draws %s', async (_name, input, texts, webLabel) => {
    mockInboxStatus.mockResolvedValue(input);
    await render(<PostHogInboxScreen />);
    expect(await screen.findByText(webLabel)).toBeVisible();
    for (const text of texts) expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(mockInboxStatus).toHaveBeenCalledWith('ws-1');
    expect(screen.queryByText(/disconnect/i)).toBeNull();
    expect(screen.queryByText('Connect PostHog')).toBeNull();
  });

  it('shows a retry notice and still links to the web when the load fails', async () => {
    mockInboxStatus.mockRejectedValue(new Error('boom'));
    await render(<PostHogInboxScreen />);
    expect(await screen.findByText('Manage on the web')).toBeVisible();
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.queryByText('Not connected')).toBeNull();
  });
});

const STATES = Object.keys(POSTHOG_INBOX_BACKLOG_STATE_LABELS) as PostHogInboxBacklogRow['state'][];
const backlogRow = (id: string, extra: Partial<PostHogInboxBacklogRow> = {}): PostHogInboxBacklogRow => ({
  id, title: `Report ${id}`, url: `https://us.posthog.com/inbox/${id}`, priority: 'P1', actionability: 'immediately_actionable', repository: 'acme/app',
  sourceProducts: [], signalCount: 2, createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z', state: 'not_run', selectable: true,
  runId: null, workbenchId: null, pullRequestId: null, prUrl: null, ...extra,
});
const backlogPage = (rows: PostHogInboxBacklogRow[], nextOffset: number | null = null): PostHogInboxBacklogPage => ({
  rows, scanned: rows.length, nextOffset, total: null, days: 7, workflowId: 'r1', runnable: true, notRunnableReason: null, dailyCap: 10, runsToday: 0,
});

describe('PostHog Inbox backlog model', () => {
  it.each(STATES)('labels the state %s', (state) => {
    expect(backlogStateLabel({ state })).toBe(POSTHOG_INBOX_BACKLOG_STATE_LABELS[state]);
    expect(backlogRowText({ title: 'T', priority: 'P0', repository: 'a/b', state }).detail).toBe(`P0 · a/b · ${POSTHOG_INBOX_BACKLOG_STATE_LABELS[state]}`);
  });

  it.each([
    [{ title: ' Crash ', priority: 'P0', repository: 'a/b' }, 'Crash', 'P0 · a/b · Not run'],
    [{ title: '', priority: 'P2', repository: null }, 'Untitled report', 'P2 · Not run'],
    [{ title: 'X', priority: null, repository: ' ' }, 'X', 'Not run'],
  ])('words the row %j', (input, title, detail) => {
    expect(backlogRowText({ ...input, state: 'not_run' } as never)).toEqual({ title, detail });
  });

  it.each([
    [{ trigger: 'manual', triggeredBy: 'octo' }, 'Started by octo'],
    [{ trigger: 'manual', triggeredBy: ' a@b.c ' }, 'Started by a@b.c'],
    [{ trigger: 'manual', triggeredBy: null }, 'Started by hand'],
    [{ trigger: 'event', triggeredBy: 'octo' }, null],
    [{ triggeredBy: 'octo' }, null],
    [{}, null],
  ])('words the manual run %j', (run, text) => {
    expect(manualRunText(run as never)).toBe(text);
  });
});

describe('PostHog Inbox backlog on the rule screen', () => {
  beforeEach(() => {
    mockBacklog.mockReset();
    mockOpenExternal.mockReset();
    mockRuns.mockReturnValue([]);
  });

  it('lists the rows with their state, opens a report, and has no run button', async () => {
    mockBacklog.mockResolvedValue(backlogPage(STATES.map((state, i) => backlogRow(`r${i}`, { state }))));
    await render(<RuleDetailScreen kind="workflow" id="r1" integration="posthog_inbox" />);
    expect(await screen.findByText('Report r0')).toBeVisible();
    for (const state of STATES) expect(screen.getAllByText(new RegExp(POSTHOG_INBOX_BACKLOG_STATE_LABELS[state])).length).toBeGreaterThan(0);
    expect(screen.getByText(/use the web or desktop app/)).toBeVisible();
    expect(mockBacklog).toHaveBeenCalledWith('ws-1', { workflowId: 'r1' });
    expect(screen.queryByText(/run selected/i)).toBeNull();
    expect(screen.queryByText(/^run$/i)).toBeNull();
    expect(screen.queryByText('Load more')).toBeNull();
    fireEvent.press(screen.getByText('Report r1'));
    expect(mockOpenExternal).toHaveBeenCalledWith('https://us.posthog.com/inbox/r1');
  });

  it('loads more rows while there is a next offset', async () => {
    mockBacklog.mockResolvedValueOnce(backlogPage([backlogRow('a')], 25)).mockResolvedValueOnce(backlogPage([backlogRow('b')], null));
    await render(<RuleDetailScreen kind="workflow" id="r1" integration="posthog_inbox" />);
    const button = await screen.findByText('Load more');
    await act(async () => { fireEvent.press(button); });
    expect(await screen.findByText('Report b')).toBeVisible();
    expect(screen.getByText('Report a')).toBeVisible();
    expect(mockBacklog).toHaveBeenLastCalledWith('ws-1', { workflowId: 'r1', offset: 25 });
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('says so when no report matches', async () => {
    mockBacklog.mockResolvedValue(backlogPage([]));
    await render(<RuleDetailScreen kind="workflow" id="r1" integration="posthog_inbox" />);
    expect(await screen.findByText('No matching reports')).toBeVisible();
  });

  it('shows an error notice when the backlog fails to load', async () => {
    mockBacklog.mockRejectedValue(new Error('boom'));
    await render(<RuleDetailScreen kind="workflow" id="r1" integration="posthog_inbox" />);
    expect(await screen.findByText('This view could not load.')).toBeVisible();
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('shows who started a manual run', async () => {
    mockBacklog.mockResolvedValue(backlogPage([]));
    mockRuns.mockReturnValue([
      { id: 'u1', integration: 'posthog_inbox', status: 'succeeded', subjectLabel: 'Manual report', actions: [], event: 'report_ready', createdAt: '2026-11-16T10:00:00Z', trigger: 'manual', triggeredBy: 'octo' },
      { id: 'u2', integration: 'posthog_inbox', status: 'succeeded', subjectLabel: 'Event report', actions: [], event: 'report_ready', createdAt: '2026-11-16T10:00:00Z', trigger: 'event', triggeredBy: null },
    ]);
    await render(<RuleDetailScreen kind="workflow" id="r1" integration="posthog_inbox" />);
    expect(await screen.findByText('Started by octo')).toBeVisible();
    expect(screen.getAllByText(/Started by/)).toHaveLength(1);
  });
});
