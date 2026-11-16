import type { WorkflowConditions, WorkflowWithStats } from '@talyn/shared';
import { render, screen } from '@testing-library/react-native';

import { RuleDetailScreen } from '../features/integrations/RuleDetailScreen';
import { dailyCapText, postHogInboxConditionFacts, postHogInboxPushText, ruleIntegration } from '../features/integrations/model';

const mockRule = {
  id: 'r1', workspaceId: 'ws-1', integration: 'posthog_inbox', name: 'Fix urgent reports', enabled: true, events: ['report_ready'],
  conditions: { priorities: ['P0', 'P1'], scouts: { exclude: ['noisy'] }, minSignalCount: 3 },
  actions: [{ type: 'start_task', repositoryId: 'repo-1', prompt: 'Fix' }], maxRunsPerPrPerHour: 5, maxRunsPerDay: 10, createdAt: '', updatedAt: '',
  stats: { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null },
} as unknown as WorkflowWithStats;

jest.mock('../auth/AuthProvider', () => ({ useNetwork: () => 'online' }));
jest.mock('../features/automations/data', () => ({
  useWorkflowList: () => ({ status: 'ready', data: [mockRule], refresh: jest.fn(), refreshing: false }),
  useLoopList: () => ({ status: 'ready', data: undefined, refresh: jest.fn(), refreshing: false }),
  useRuns: () => ({ status: 'ready', data: [], refresh: jest.fn(), refreshing: false }),
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

  it.each<[string, { lastPushAt: string | null; pushConfigured: boolean } | null, RegExp | null]>([
    ['no status yet', null, null],
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
