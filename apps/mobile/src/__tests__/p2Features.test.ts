import type {
  BillingStatus, FleetAccountView, InsightsAgentsResponse, InsightsComputeResponse, InsightsOutputResponse, InsightsSpeedResponse,
  LoopRunStatus, LoopWithStats, SpacePresenceMember, SpaceSessionRow, SpacesTeam, Workbench, WorkflowRunStatus, WorkflowWithStats,
} from '@talyn/shared';

import {
  accountBadge, accountKindLabel, accountUsageText, accountsFor, defaultFleetModel, defaultProviderLabel, formatTimeAt, providerRows, summaryWindow,
} from '../features/agents/model';
import {
  loopDisabledText, loopRunBadge, loopRunText, loopSummary, loopToggleInput, nextRunText, problemsText, withEnabled, workflowRunBadge,
  workflowRunText, workflowSummary, workflowToggleInput,
} from '../features/automations/model';
import { dayShares, insightTiles, repositoryBars } from '../features/insights/model';
import { NAV_ITEMS, visibleNavItems } from '../features/more/navItems';
import { MIN_REFRESH_MS, refreshInterval } from '../features/more/useRemote';
import { moveToSpaceAction } from '../features/spaces/actions';
import {
  activeLogins, canMoveToSpace, findSpace, groupSpaceSessions, hiddenText, moveChoices, openTarget, placeLabel, presenceSentence,
  spaceInitials, spaceSessionState, viewersOf,
} from '../features/spaces/model';
import { formatLeftPercent, gaugeLevel, leftPercent, shortDate, usageLines, usageViewOf } from '../features/usage/model';

const mockMoveSession = jest.fn();
jest.mock('@talyn/client/native', () => ({
  ...jest.requireActual('@talyn/client/native'),
  spaces: { moveSession: (...args: unknown[]) => mockMoveSession(...args) },
}));
jest.mock('../auth/AuthProvider', () => ({
  useAuth: jest.fn(), useMobileRuntime: jest.fn(), useNetwork: jest.fn(), useWorkspace: jest.fn(),
}));
const mockShowActionError = jest.fn();
jest.mock('../lib/errors', () => ({ showActionError: (...args: unknown[]) => mockShowActionError(...args) }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const usage = (patch: Partial<NonNullable<BillingStatus['usage']>> = {}) => ({
  periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-11-30T12:00:00Z', includedWsec: 200 * 3600, usedWsec: 50 * 3600,
  percent: 25, exhausted: false, ...patch,
});
const billing = (patch: Partial<BillingStatus> = {}): BillingStatus => ({
  billingEnabled: true, plan: 'free', planSource: 'subscription', cancelAtPeriodEnd: false, activeTasks: 0, activeTaskLimit: null,
  queuedPrs: 0, mergeQueueLimit: null, workflows: 0, workflowLimit: null, loops: 0, loopLimit: null, activeReviews: 0,
  activeReviewLimit: null, tier: 'pro', usage: usage(), ...patch,
} as BillingStatus);

const space = (id: string, name = id) => ({ id, teamId: 't1', name, color: '#336699', image: null, createdByUserId: null,
  archivedAt: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
const teams: SpacesTeam[] = [
  { id: 't1', name: 'Core', role: 'member', homeWorkspaceId: 'w1', spaces: [space('s1', 'Infra'), space('s2', 'Web app')], createdAt: '' },
  { id: 't2', name: 'Growth', role: 'owner', homeWorkspaceId: 'w1', spaces: [], createdAt: '' },
];
const row = (patch: Partial<SpaceSessionRow> = {}): SpaceSessionRow => ({
  id: 'r1', spaceId: 's1', workspaceId: 'w1', kind: 'session', threadId: null, name: 'Name', title: null, status: 'ready',
  sandboxState: 'running', running: false, repoFullName: 'acme/app', branch: 'b', baseBranch: 'main', agent: 'claude', model: null,
  pullRequest: null, creator: { userId: 'u2', githubLogin: 'ana', avatarUrl: null }, lastActivityAt: '2026-11-08T10:00:00Z',
  archivedAt: null, createdAt: '2026-11-08T09:00:00Z', updatedAt: '2026-11-08T10:00:00Z', ...patch,
} as SpaceSessionRow);
const member = (userId: string, login: string | null, sessionId: string | null, state: 'active' | 'away' = 'active'): SpacePresenceMember =>
  ({ userId, githubLogin: login, avatarUrl: null, sessionId, state, at: 0 });

const account = (patch: Partial<FleetAccountView> = {}): FleetAccountView => ({
  id: 'a1', agent: 'claude', kind: 'claude_oauth', label: 'Work', priority: 0, needsReauth: false, held: null, usage: null, over: false, ...patch,
});

const workflow = (patch: Partial<WorkflowWithStats> = {}): WorkflowWithStats => ({
  id: 'wf1', workspaceId: 'w1', name: 'Label new PRs', enabled: true, events: ['pr_opened'], conditions: {},
  actions: [{ type: 'add_labels', labels: ['triage'] }], maxRunsPerPrPerHour: 5, createdAt: '', updatedAt: '',
  stats: { runsTotal: 3, runs24h: 1, runs7d: 2, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null }, ...patch,
} as WorkflowWithStats);
const loop = (patch: Partial<LoopWithStats> = {}): LoopWithStats => ({
  id: 'l1', workspaceId: 'w1', name: 'Daily sweep', enabled: true, prompt: 'Fix things', cron: '0 9 * * *', timezone: 'Europe/London',
  provider: 'selfhosted', model: 'claude-opus-5-5', target: 'session', concurrency: 'skip', internetAccess: false, mcpServerIds: null,
  repositoryId: 'repo1', repoFullName: 'acme/app', nextRunAt: null, disabledReason: null, createdAt: '', updatedAt: '',
  stats: { runsTotal: 0, runs7d: 0, failures7d: 0, lastRunAt: null, lastStatus: null }, ...patch,
} as LoopWithStats);

// ---------------------------------------------------------------------------

describe('navigation entries', () => {
  const keys = (features: Parameters<typeof visibleNavItems>[0], status?: BillingStatus | null) =>
    visibleNavItems(features, status).map((item) => item.key);

  it.each([
    ['features still loading', null, null, ['integrations', 'insights', 'agents']],
    ['nothing offered', {}, null, ['integrations', 'insights', 'agents']],
    ['spaces only', { spaces: true }, null, ['spaces', 'integrations', 'insights', 'agents']],
    ['spaces false', { spaces: false }, null, ['integrations', 'insights', 'agents']],
    ['workflows only', { workflows: true }, null, ['integrations', 'insights', 'agents']],
    ['loops only', { loops: true }, null, ['integrations', 'insights', 'agents']],
    ['usage billing on', {}, billing(), ['integrations', 'insights', 'usage', 'agents']],
    ['billing disabled', {}, billing({ billingEnabled: false }), ['integrations', 'insights', 'agents']],
    ['backend without usage', {}, billing({ tier: undefined, usage: undefined }), ['integrations', 'insights', 'agents']],
    ['everything', { spaces: true, workflows: true, loops: true }, billing(), ['spaces', 'integrations', 'insights', 'usage', 'agents']],
  ])('%s', (_name, features, status, expected) => {
    expect(keys(features as never, status)).toEqual(expected);
  });

  it('gives every entry a label, a route and icons for both platforms', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label).toBeTruthy();
      expect(item.route).toBeTruthy();
      expect(item.icon).toEqual(expect.objectContaining({ ios: expect.any(String), android: expect.any(String) }));
    }
  });

});

describe('refresh interval', () => {
  it.each([
    [undefined, null], [0, null], [-5, null], [1_000, MIN_REFRESH_MS], [MIN_REFRESH_MS, MIN_REFRESH_MS], [120_000, 120_000],
  ])('%s ms gives %s', (input, expected) => { expect(refreshInterval(input)).toBe(expected); });
});

describe('usage', () => {
  it.each([
    ['no status', null, false],
    ['billing off', billing({ billingEnabled: false }), false],
    ['unknown tier', billing({ tier: 'enterprise' as never }), false],
    ['no usage', billing({ usage: undefined }), false],
    ['usage billing', billing(), true],
  ])('usage view for %s', (_name, status, shown) => { expect(usageViewOf(status) !== null).toBe(shown); });

  it.each([
    [0, false, 'ok'], [49, false, 'ok'], [50, false, 'half'], [80, false, 'high'], [99, false, 'high'], [100, false, 'full'], [10, true, 'full'],
  ])('gauge level at %s%% (exhausted %s)', (percent, exhausted, level) => {
    expect(gaugeLevel({ percent, exhausted })).toBe(level);
  });

  it.each([
    [25, false, 75, '75% left'], [95, false, 5, '5% left'], [99.5, false, 0.5, 'Less than 1% left'], [100, false, 0, '0% left'],
    [120, false, 0, '0% left'], [10, true, 0, '0% left'],
  ])('left at %s%% used', (percent, exhausted, left, text) => {
    expect(leftPercent(percent, exhausted)).toBe(left);
    expect(formatLeftPercent(percent, exhausted)).toBe(text);
  });

  it.each([[null, ''], ['nonsense', ''], ['2026-11-30T12:00:00Z', '30 Nov']])('short date of %s', (iso, text) => {
    expect(shortDate(iso)).toBe(text);
  });

  it('summarises a Pro plan with credits and auto top-up', () => {
    const lines = usageLines(usageViewOf(billing({
      credits: { balanceMicros: 12_500_000, expiringSoonMicros: 2_000_000, lots: [] },
      autoTopup: { enabled: true, triggerMicros: 5_000_000, pack: '25', monthlyLimitMicros: 100_000_000, monthSpentMicros: 0, lastFailure: 'Card declined', lastFailureAt: null },
      concurrentBoxes: { used: 3, limit: 100 },
    }))!);
    expect(lines).toEqual({
      plan: 'Pro', left: '75% left', used: '50 of 200 box-hours used', reset: 'Resets 30 Nov', exhausted: null,
      boxes: '3 of 100 running', credits: '$12.50', expiring: '$2.00 expires in the next 30 days', autoTopup: 'On, below $5',
      autoTopupProblem: 'The last top-up failed: Card declined', team: null,
    });
  });

  it.each([
    ['free has no credits line', billing({ tier: 'free' }), { credits: null, autoTopup: null, boxes: 'Up to 2 at the same time' }],
    ['exhausted', billing({ usage: usage({ exhausted: true, percent: 100 }) }), { exhausted: 'Out of hours: new boxes paused' }],
    ['auto top-up off', billing({ autoTopup: { enabled: false } as never }), { autoTopup: 'Off' }],
    ['team seat', billing({ team: { id: 't', name: 'Acme', isAdmin: false, hasSeat: true, soleAdmin: false, active: true } as never }), { team: 'Seat on Acme' }],
    ['team admin', billing({ team: { id: 't', name: 'Acme', isAdmin: true, hasSeat: false, soleAdmin: true, active: true } as never }), { team: 'Admin of Acme' }],
  ])('%s', (_name, status, expected) => {
    expect(usageLines(usageViewOf(status)!)).toEqual(expect.objectContaining(expected));
  });
});

describe('agents', () => {
  const now = new Date(2026, 10, 9, 10, 0);
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

  it.each([
    [at(9, 14, 5), 'resets today at 14:05'],
    [at(10, 9), 'resets tomorrow at 09:00'],
    [at(12, 9), 'resets Thu at 09:00'],
    [at(20, 9), 'resets Fri 20 Nov at 09:00'],
    ['nonsense', 'resets at an unknown time'],
  ])('time at %s', (iso, text) => { expect(formatTimeAt(iso, 'resets', now)).toBe(text); });

  it.each([
    ['connected', account(), 80, { label: 'Connected', tone: 'success' }],
    ['reconnect wins', account({ needsReauth: true, held: { until: null }, over: true }), 80, { label: 'Reconnect needed', tone: 'destructive' }],
    ['held with a time', account({ held: { until: at(9, 15) } }), 80, { label: 'Limit reached, can retry today at 15:00', tone: 'warning' }],
    ['held without a time', account({ held: { until: null } }), 80, { label: 'Limit reached', tone: 'warning' }],
    ['over the switch point', account({ over: true }), 80, { label: 'Over 80%', tone: 'destructive' }],
    ['over at 100', account({ over: true }), 100, { label: 'Limit reached', tone: 'destructive' }],
  ])('badge: %s', (_name, value, switchAt, expected) => { expect(accountBadge(value, switchAt, now)).toEqual(expected); });

  it.each([
    ['claude_oauth', 'Claude subscription'], ['codex_oauth', 'ChatGPT subscription'], ['anthropic_key', 'API key'], ['openai_key', 'API key'],
  ] as const)('kind %s', (kind, label) => { expect(accountKindLabel(kind)).toBe(label); });

  const windows = (list: Array<[string, string, number]>) => list.map(([key, label, usedPercent]) => ({ key, label, usedPercent, resetsAt: null }));
  it.each([
    ['weekly_all first', windows([['five_hour', '5 hours', 90], ['weekly_all', 'Weekly', 10]]), 'weekly_all'],
    ['plain weekly next', windows([['five_hour', '5 hours', 90], ['weekly', 'Weekly', 10], ['weekly:opus', 'Weekly', 5]]), 'weekly'],
    ['fullest otherwise', windows([['a', 'A', 10], ['b', 'B', 70]]), 'b'],
    ['none', [], null],
  ])('summary window: %s', (_name, list, key) => { expect(summaryWindow(list)?.key ?? null).toBe(key); });

  it.each([
    ['api key', account({ kind: 'anthropic_key' }), 'No usage data for API keys'],
    ['not checked', account(), 'Usage not checked yet'],
    ['error', account({ usage: { fetchedAt: '', error: 'timeout' } }), 'Usage unavailable: timeout'],
    ['window', account({ usage: { fetchedAt: '', windows: [{ key: 'weekly_all', label: 'Weekly', usedPercent: 42, resetsAt: at(10, 9) }] } }),
      'Weekly 42% · resets tomorrow at 09:00'],
  ])('usage text: %s', (_name, value, text) => { expect(accountUsageText(value, now)).toBe(text); });

  it('orders accounts of one agent by priority', () => {
    const list = [account({ id: 'b', priority: 2 }), account({ id: 'x', agent: 'codex', priority: 0 }), account({ id: 'a', priority: 1 })];
    expect(accountsFor(list, 'claude').map((item) => item.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['connected fleet', { type: 'selfhosted', displayName: 'Talyn Fleet', connected: true, connectedAgents: ['claude'] }, false, 'success'],
    ['fleet reauth', { type: 'selfhosted', displayName: 'Talyn Fleet', connected: true, connectedAgents: ['claude'], reauthAgents: ['claude'] }, false, 'warning'],
    ['disconnected', { type: 'posthog_code', displayName: 'PostHog Code', connected: false }, false, 'muted'],
    ['posthog reauth folds in', { type: 'posthog_code', displayName: 'PostHog Code', connected: true }, true, 'warning'],
  ])('provider row: %s', (_name, provider, reauth, tone) => {
    expect(providerRows([provider as never], reauth)[0].tone).toBe(tone);
  });

  const providers = [{ type: 'selfhosted', displayName: 'Talyn Fleet' }, { type: 'posthog_code', displayName: 'PostHog Code' }];
  it.each([
    [undefined, 'Automatic'], [{}, 'Automatic'], [{ defaultCloudProvider: 'ask' }, 'Ask every time'],
    [{ defaultCloudProvider: 'posthog_code' }, 'PostHog Code'], [{ defaultCloudProvider: 'selfhosted' }, 'Talyn Fleet'],
  ])('default provider for %j', (settings, label) => { expect(defaultProviderLabel(settings as never, providers)).toBe(label); });

  it.each([[undefined, ''], [{ fleetModel: 'claude-opus-5-5' }, 'Opus 5.5']])('default fleet model for %j', (settings, label) => {
    expect(defaultFleetModel(settings as never)).toBe(label);
  });
});

describe('automations', () => {
  it.each([
    [workflow(), 'When pr opened → add labels'],
    [workflow({ events: ['pr_opened', 'pr_reopened', 'pr_merged'] }), 'When pr opened + 2 more → add labels'],
    [workflow({ actions: [] }), 'When pr opened'],
    [workflow({ integration: 'slack', events: ['slack_message'], conditions: { channels: ['C123'] },
      actions: [{ type: 'start_session', repositoryId: null, prompt: 'Help' }] }), 'In #C123, start a session'],
    [workflow({ integration: 'slack', events: ['slack_message'], conditions: { channels: ['#general', 'C123'] },
      actions: [{ type: 'slack_reply', text: 'Hello' }] }), 'In #general or #C123, reply in the thread'],
  ])('workflow summary %#', (value, text) => { expect(workflowSummary(value)).toBe(text); });

  it('describes a loop schedule and repository', () => {
    expect(loopSummary(loop())).toBe('Every day at 09:00 (Europe/London) · acme/app');
  });

  const now = Date.parse('2026-11-09T10:00:00Z');
  it.each([
    ['off', loop({ enabled: false, nextRunAt: '2026-11-09T11:00:00Z' }), 'Paused'],
    ['no next run', loop(), 'Not scheduled'],
    ['overdue', loop({ nextRunAt: '2026-11-09T09:59:00Z' }), 'Next run due now'],
    ['minutes', loop({ nextRunAt: '2026-11-09T10:05:00Z' }), 'Next run in 5m'],
    ['hours', loop({ nextRunAt: '2026-11-09T13:00:00Z' }), 'Next run in 3h'],
    ['days', loop({ nextRunAt: '2026-11-12T10:00:00Z' }), 'Next run in 3d'],
  ])('next run when %s', (_name, value, text) => { expect(nextRunText(value, now)).toBe(text); });

  it.each([[0, null], [1, '1 problem this week'], [3, '3 problems this week']])('problems %s', (failures, text) => {
    expect(problemsText(failures)).toBe(text);
  });

  it.each([
    ['succeeded', 'Done', 'success'], ['failed', 'Failed', 'destructive'], ['partial', 'Partly done', 'warning'],
    ['pending_retry', 'Waiting to retry', 'warning'], ['running', 'Running', 'information'], ['skipped', 'Stood down', 'muted'],
  ] as Array<[WorkflowRunStatus, string, string]>)('workflow run %s', (status, label, tone) => {
    expect(workflowRunBadge(status)).toEqual({ label, tone });
  });

  it.each([
    ['succeeded', 'Succeeded', 'success'], ['failed', 'Failed', 'destructive'], ['queued', 'Queued', 'information'],
    ['waiting_slot', 'Waiting to start', 'warning'], ['skipped', 'Skipped', 'muted'],
  ] as Array<[LoopRunStatus, string, string]>)('loop run %s', (status, label, tone) => {
    expect(loopRunBadge(status)).toEqual({ label, tone });
  });

  it.each([[null, null], ['too_many_failures', 'Turned off after five runs failed in a row.']])('disabled reason %s', (reason, text) => {
    expect(loopDisabledText(loop({ disabledReason: reason as never }))).toBe(text);
  });

  it('sends the whole workflow with only enabled changed', () => {
    const value = workflow();
    expect(workflowToggleInput(value, false)).toEqual({ integration: value.integration, name: value.name, enabled: false, events: value.events,
      conditions: value.conditions, actions: value.actions, maxRunsPerPrPerHour: 5 });
  });

  it('keeps Slack rules in Slack when toggled', () => {
    const value = workflow({ integration: 'slack' });
    expect(workflowToggleInput(value, false).integration).toBe('slack');
  });

  it('sends the whole loop with only enabled changed', () => {
    expect(loopToggleInput(loop(), false)).toEqual(expect.objectContaining({ enabled: false, name: 'Daily sweep', cron: '0 9 * * *',
      repositoryId: 'repo1', model: 'claude-opus-5-5', internetAccess: false }));
  });

  it('flips one item for the optimistic switch', () => {
    const items = [workflow({ id: 'a' }), workflow({ id: 'b' })];
    expect(withEnabled(items, 'b', false).map((item) => item.enabled)).toEqual([true, false]);
    expect(items[1].enabled).toBe(true);
  });

  it.each([
    ['ok run', { prNumber: 7, prTitle: 'Fix', repoFullName: 'acme/app', event: 'pr_opened', actions: [], error: null }, { title: 'Fix', detail: 'acme/app · PR opened' }],
    ['no title', { prNumber: 7, prTitle: '', repoFullName: 'acme/app', event: 'pr_opened', actions: [], error: null }, { title: 'Pull request #7', detail: 'acme/app · PR opened' }],
    ['failed action', { prNumber: 7, prTitle: 'Fix', repoFullName: 'acme/app', event: 'pr_opened', actions: [{ type: 'add_labels', ok: false, error: 'No access' }], error: null },
      { title: 'Fix', detail: 'Add labels: No access' }],
    ['Slack message', { integration: 'slack', subjectLabel: '#general', prNumber: 0, prTitle: '', repoFullName: '',
      event: 'slack_message', actions: [], error: null }, { title: '#general', detail: 'New message in a channel' }],
    ['Slack scope missing', { integration: 'slack', subjectLabel: '#general', prNumber: 0, prTitle: '', repoFullName: '',
      event: 'slack_message', actions: [{ type: 'slack_reply', ok: false, code: 'slack_scope_missing', error: 'raw' }], error: null },
      { title: '#general', detail: 'Slack did not allow this reply. Reinstall Slack to grant the chat:write permission.' }],
  ])('workflow run text: %s', (_name, run, expected) => {
    const text = workflowRunText(run as never);
    expect(text.title).toBe(expected.title);
    expect(text.detail.toLowerCase()).toBe(expected.detail.toLowerCase());
  });

  it.each([
    ['manual', { trigger: 'manual', failureCode: null, error: null, repoFullName: 'acme/app' }, { title: 'Run now', detail: 'acme/app' }],
    ['failure label', { trigger: 'schedule', failureCode: 'dispatch_failed', error: 'x', repoFullName: 'acme/app' }, { title: 'Scheduled run', detail: 'The run could not start' }],
    ['raw error', { trigger: 'schedule', failureCode: null, error: 'Boom', repoFullName: 'acme/app' }, { title: 'Scheduled run', detail: 'Boom' }],
  ])('loop run text: %s', (_name, run, expected) => { expect(loopRunText(run as never)).toEqual(expected); });
});

describe('spaces', () => {
  it.each([['s2', 'Web app', 'Core'], ['missing', null, null], [null, null, null]])('find space %s', (id, name, team) => {
    const found = findSpace(teams, id);
    expect(found?.space.name ?? null).toBe(name);
    expect(found?.team.name ?? null).toBe(team);
  });

  it.each([['Infra', 'I'], ['Web app', 'WA'], ['  ', '?'], ['été team', 'ÉT']])('initials of %j', (name, text) => {
    expect(spaceInitials(name)).toBe(text);
  });

  it.each([
    [[], null],
    [[{ githubLogin: 'ana' }], 'ana is here'],
    [[{ githubLogin: 'ana' }, { githubLogin: null }], 'ana and A teammate are here'],
    [[{ githubLogin: 'a' }, { githubLogin: 'b' }, { githubLogin: 'c' }], 'a, b and 1 other are here'],
    [[{ githubLogin: 'a' }, { githubLogin: 'b' }, { githubLogin: 'c' }, { githubLogin: 'd' }], 'a, b and 2 others are here'],
  ])('presence sentence %#', (members, text) => { expect(presenceSentence(members)).toBe(text); });

  const presence = [member('me', 'tom', 'r1'), member('u2', 'ana', 'r1'), member('u3', 'ben', 'r1', 'away'), member('u4', 'cy', 'r2')];
  it('lists the teammates viewing a session, me and away people left out', () => {
    expect(viewersOf(presence, 'r1', 'me').map((item) => item.githubLogin)).toEqual(['ana']);
  });
  it('collects active logins in lower case', () => {
    expect([...activeLogins([...presence, member('u5', 'Dee', null)])]).toEqual(['tom', 'ana', 'cy', 'dee']);
  });

  it('groups active and recent sessions, newest first, without archived ones', () => {
    const rows = [
      row({ id: 'old', lastActivityAt: '2026-11-01T00:00:00Z' }),
      row({ id: 'running', running: true }),
      row({ id: 'viewed', lastActivityAt: '2026-11-07T00:00:00Z' }),
      row({ id: 'new', lastActivityAt: '2026-11-09T00:00:00Z' }),
      row({ id: 'gone', archivedAt: '2026-11-09T00:00:00Z' }),
      row({ id: 'archived', status: 'archived' }),
    ];
    const groups = groupSpaceSessions(rows, [member('u2', 'ana', 'viewed'), member('me', 'tom', 'old')], 'me');
    expect(groups.active.map((item) => item.id)).toEqual(['running', 'viewed']);
    expect(groups.recent.map((item) => item.id)).toEqual(['new', 'old']);
  });

  it.each([
    ['idle', row(), 'idle'],
    ['running', row({ running: true }), 'working'],
    ['error', row({ status: 'error' }), 'failed'],
    ['merged pr', row({ pullRequest: { number: 4, state: 'merged', url: 'u' } }), 'merged'],
    ['closed pr', row({ pullRequest: { number: 4, state: 'closed', url: 'u' } }), 'closed'],
    ['open pr', row({ pullRequest: { number: 4, state: 'open', url: 'u' } }), 'pr_waiting'],
    ['thread ignores pr', row({ kind: 'thread', pullRequest: { number: 4, state: 'open', url: 'u' } }), 'idle'],
  ])('space row state: %s', (_name, value, kind) => { expect(spaceSessionState(value).kind).toBe(kind); });

  it.each([[0, null], [-1, null], [1, "1 item you can't see"], [4, "4 items you can't see"]])('hidden %s', (count, text) => {
    expect(hiddenText(count)).toBe(text);
  });

  it.each([
    ['my session', row(), 'w1', { kind: 'route', href: { pathname: '/sessions/[id]', params: { id: 'r1' } } }],
    ['my thread', row({ kind: 'thread' }), 'w1', { kind: 'route', href: { pathname: '/threads/[id]', params: { id: 'r1' } } }],
    ['a teammate', row({ workspaceId: 'w9' }), 'w1', { kind: 'web', path: '/s/r1' }],
    ['no workspace', row(), null, { kind: 'web', path: '/s/r1' }],
  ])('open target: %s', (_name, value, workspaceId, expected) => { expect(openTarget(value, workspaceId)).toEqual(expected); });

  it.each([[row(), 'acme/app'], [row({ kind: 'thread' }), 'Thread']])('place label %#', (value, text) => { expect(placeLabel(value)).toBe(text); });

  it('lists Personal then each space, checking the current place', () => {
    expect(moveChoices(teams, 's2')).toEqual([
      { spaceId: null, label: 'Personal', team: null, selected: false },
      { spaceId: 's1', label: 'Infra', team: 'Core', selected: false },
      { spaceId: 's2', label: 'Web app', team: 'Core', selected: true },
    ]);
    expect(moveChoices([], null)).toEqual([{ spaceId: null, label: 'Personal', team: null, selected: true }]);
  });

  const mine = { workspaceId: 'w1', archivedAt: null } as Pick<Workbench, 'workspaceId' | 'archivedAt'>;
  it.each([
    ['mine with teams', mine, { offered: true, teams, workspaceId: 'w1' }, true],
    ['spaces off', mine, { offered: false, teams, workspaceId: 'w1' }, false],
    ['teams loading', mine, { offered: true, teams: null, workspaceId: 'w1' }, false],
    ['a teammate', { ...mine, workspaceId: 'w9' }, { offered: true, teams, workspaceId: 'w1' }, false],
    ['archived', { ...mine, archivedAt: '2026-11-01T00:00:00Z' }, { offered: true, teams, workspaceId: 'w1' }, false],
    ['no workspace', mine, { offered: true, teams, workspaceId: null }, false],
  ])('can move: %s', (_name, value, context, expected) => { expect(canMoveToSpace(value, context)).toBe(expected); });
});

describe('move to space action', () => {
  const workbench = { id: 'wb1', workspaceId: 'w1', archivedAt: null, spaceId: 's1', kind: 'session' } as unknown as Workbench;
  beforeEach(() => { mockMoveSession.mockReset(); mockShowActionError.mockReset(); });

  it('is not offered when Spaces is off', () => {
    expect(moveToSpaceAction(workbench, { offered: false, teams, workspaceId: 'w1', openSheet: jest.fn() })).toBeNull();
  });

  it('opens a picker and moves to the chosen space', async () => {
    const openSheet = jest.fn();
    const onMoved = jest.fn();
    mockMoveSession.mockResolvedValue({ ...workbench, spaceId: null });
    const action = moveToSpaceAction(workbench, { offered: true, teams, workspaceId: 'w1', openSheet, onMoved })!;
    expect(action).toEqual(expect.objectContaining({ label: 'Move to space…', disabled: false }));
    action.run();
    const request = openSheet.mock.calls[0][0];
    expect(request.title).toBe('Move session');
    expect(request.actions.map((item: { label: string; selected: boolean }) => [item.label, item.selected]))
      .toEqual([['Personal', false], ['Infra', true], ['Web app', false]]);
    request.actions[1].onPress();
    expect(mockMoveSession).not.toHaveBeenCalled();
    request.actions[0].onPress();
    await Promise.resolve(); await Promise.resolve();
    expect(mockMoveSession).toHaveBeenCalledWith('wb1', null);
    expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ spaceId: null }));
  });

  it('reports a failed move', async () => {
    const openSheet = jest.fn();
    mockMoveSession.mockRejectedValue(new Error('No'));
    moveToSpaceAction({ ...workbench, kind: 'thread' } as Workbench, { offered: true, teams, workspaceId: 'w1', openSheet })!.run();
    expect(openSheet.mock.calls[0][0].title).toBe('Move thread');
    openSheet.mock.calls[0][0].actions[2].onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockShowActionError).toHaveBeenCalledWith('Could not move it', expect.any(Error));
  });

  it('is disabled offline', () => {
    expect(moveToSpaceAction(workbench, { offered: true, teams, workspaceId: 'w1', offline: true, openSheet: jest.fn() }))
      .toEqual(expect.objectContaining({ disabled: true, detail: 'You are offline.' }));
  });
});

describe('insights', () => {
  const compute = { totalWsec: 7200, boxes: 3, days: [], bySize: [], byKind: [], period: null } as unknown as InsightsComputeResponse;
  const agents = { totals: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 4, failedTurns: 1,
    agentSteps: 0, costMicros: null, turnsWithCost: 0 } } as unknown as InsightsAgentsResponse;
  const output = { sessions: { created: 5, withPullRequest: 2, pullRequestsMerged: 1 }, mergeQueue: { landed: 0 } } as unknown as InsightsOutputResponse;
  const speed = { firstReply: { count: 2, p50Ms: 4200, p90Ms: 9000 } } as unknown as InsightsSpeedResponse;

  it('shows nothing for sections still loading', () => {
    expect(insightTiles({}).every((tile) => tile.value === null)).toBe(true);
  });

  it('fills the tiles from each section', () => {
    const tiles = Object.fromEntries(insightTiles({ compute, agents, output, speed }).map((tile) => [tile.key, [tile.value, tile.hint]]));
    expect(tiles).toEqual({
      'box-time': ['2 box-hours', undefined], 'box-runs': ['3', undefined], tokens: ['1.5K', undefined], turns: ['4', '1 failed'],
      cost: ['Not reported', 'At API prices'], sessions: ['5', undefined], merged: ['1', undefined], 'first-reply': ['4.2 s', 'Median'],
    });
  });

  it('scales repository bars to the largest', () => {
    expect(repositoryBars([{ repository: 'a', wsec: 7200, tokens: 0 }, { repository: 'b', wsec: 1800, tokens: 0 }]))
      .toEqual([{ key: 'a', label: 'a', value: '2 box-hours', share: 100 }, { key: 'b', label: 'b', value: '0.5 box-hours', share: 25 }]);
    expect(repositoryBars([{ repository: 'z', wsec: 0, tokens: 0 }])[0].share).toBe(0);
  });

  it.each([
    [[], []],
    [[{ date: 'd1', wsec: 0 }], [0]],
    [[{ date: 'd1', wsec: 3600 }, { date: 'd2', wsec: 1800 }], [100, 50]],
  ])('day shares %#', (days, shares) => { expect(dayShares(days).map((day) => day.share)).toEqual(shares); });
});
