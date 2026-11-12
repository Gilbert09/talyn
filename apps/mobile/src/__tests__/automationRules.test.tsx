import type { WorkflowRun, WorkflowWithStats } from '@talyn/shared';
import { render, screen, waitFor } from '@testing-library/react-native';

import IntegrationRoute from '../../app/integrations/[kind]';
import RuleDetailRoute from '../../app/integrations/[kind]/[id]';
import { RulesScreen } from '../features/integrations/RulesScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockList = jest.fn();
const mockLoopList = jest.fn();
const mockRuns = jest.fn();
const mockHrefs: unknown[] = [];
let mockParams: { kind: string; id?: string } = { kind: 'slack' };
let mockFeatures: Record<string, boolean> = { workbenches: true, workflows: true, slackChannelRules: true };

jest.mock('@talyn/client/native', () => {
  const actual = jest.requireActual('@talyn/client/native');
  return { ...actual, workflows: { ...actual.workflows,
    list: (...args: unknown[]) => mockList(...args), runs: (...args: unknown[]) => mockRuns(...args),
  }, loops: { ...actual.loops, list: (...args: unknown[]) => mockLoopList(...args) } };
});
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'ws-1', choices: [] }),
  useNetwork: () => 'online',
}));
jest.mock('../lib/features', () => ({ useFeatures: () => mockFeatures }));
jest.mock('../navigation/DetailRoute', () => ({ DetailRoute: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../features/slack/SlackScreen', () => ({ SlackScreen: () => null }));
jest.mock('../features/settings/GitHubSettingsScreen', () => ({ GitHubSettingsScreen: () => null }));
jest.mock('../features/privateRoutes/PrivateRoutesScreen', () => ({ PrivateRoutesScreen: () => null }));
jest.mock('../features/integrations/IntegrationsScreen', () => ({ IntegrationsScreen: () => null }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  Link: ({ children, href }: { children: React.ReactNode; href: unknown }) => { mockHrefs.push(href); return children; },
  Redirect: () => null,
  Stack: { Screen: () => null },
}));

const stats = { runsTotal: 2, runs24h: 1, runs7d: 2, failures7d: 1, tasksStarted: 1,
  lastRunAt: '2026-11-10T10:00:00Z', lastStatus: 'failed' as const };
const slackRule: WorkflowWithStats = {
  id: 'slack-1', workspaceId: 'ws-1', integration: 'slack', name: 'Help in support', enabled: true,
  events: ['slack_message'], conditions: { slackTeamId: 'T1', channels: ['C123'] },
  actions: [{ type: 'start_session', repositoryId: null, prompt: 'Help' }], maxRunsPerPrPerHour: 5,
  createdAt: '', updatedAt: '', stats,
};
const webhookRule: WorkflowWithStats = {
  ...slackRule, id: 'webhook-1', integration: 'webhook', name: 'Triage reports', events: ['webhook_received'], conditions: {},
  actions: [{ type: 'start_task', repositoryId: 'repo-1', prompt: 'Triage' }],
};
const githubRule: WorkflowWithStats = {
  ...slackRule, id: 'github-1', integration: 'github', name: 'Label PRs', events: ['pr_opened'], conditions: {},
  actions: [{ type: 'add_labels', labels: ['triage'] }],
};
const slackRun: WorkflowRun = {
  id: 'run-1', workflowId: 'slack-1', workspaceId: 'ws-1', integration: 'slack', subjectLabel: '#support',
  repositoryId: null, repoFullName: '', prNumber: 0, prTitle: '', prUrl: '', prAuthor: '', pullRequestId: null,
  taskId: null, event: 'slack_message', status: 'failed', actions: [{ type: 'slack_reply', ok: false,
    code: 'slack_scope_missing' as WorkflowRun['actions'][number]['code'], error: 'raw' }], error: null,
  retryAfter: null, attempts: 1, createdAt: '2026-11-10T10:00:00Z',
};

beforeEach(() => {
  mockParams = { kind: 'slack' };
  mockFeatures = { workbenches: true, workflows: true, slackChannelRules: true };
  mockList.mockImplementation(async (_workspace: string, integration: string) => integration === 'slack' ? [slackRule]
    : integration === 'webhook' ? [webhookRule] : [githubRule]);
  mockLoopList.mockResolvedValue([]);
  mockRuns.mockResolvedValue([slackRun]);
  mockHrefs.length = 0;
});

describe('integration rules', () => {
  it.each([
    ['slack', slackRule.name, 'In #C123, start a session'],
    ['github', githubRule.name, 'When pr opened → add labels'],
  ] as const)('filters %s rules and shows their summary', async (integration, name, summary) => {
    await render(<RulesScreen kind="workflow" integration={integration} />);
    expect(await screen.findByText(name)).toBeVisible();
    expect(mockList).toHaveBeenCalledWith('ws-1', integration);
    expect(screen.getByText(summary)).toBeVisible();
    expect(screen.getByText('1 problem this week')).toBeVisible();
    expect(screen.getByLabelText(`Last run: Failed`)).toBeVisible();
    expect(screen.queryByText(integration === 'slack' ? githubRule.name : slackRule.name)).toBeNull();
  });

  it.each([
    ['slack', 'workflow', 'An automation watches Slack messages and can start a session, reply or react.'],
    ['github', 'workflow', 'An automation watches pull request events and can label, comment, request reviewers, start a session and more.'],
    ['github', 'loop', 'An automation runs on a schedule and starts a session or a task.'],
  ] as const)('shows the %s %s empty state', async (integration, kind, description) => {
    mockList.mockResolvedValue([]);
    await render(<RulesScreen kind={kind} integration={integration} />);
    expect(await screen.findByText('No automations yet')).toBeVisible();
    expect(screen.getByText(description)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create an automation' })).toBeVisible();
    expect(screen.getByText('Create and edit automations in Talyn on the web.')).toBeVisible();
    expect(screen.getByText('Edit on the web')).toBeVisible();
  });

  it.each([true, false])('shows Slack rules only when the flag is %s', async (enabled) => {
    mockFeatures = { ...mockFeatures, slackChannelRules: enabled };
    await render(<IntegrationRoute />);
    if (enabled) {
      expect(await screen.findByText(slackRule.name)).toBeVisible();
      expect(screen.getByRole('tab', { name: 'Automations' })).toBeVisible();
      expect(screen.getByRole('tab', { name: 'Connection' })).toBeVisible();
      expect(mockList).toHaveBeenCalledWith('ws-1', 'slack');
    } else {
      expect(screen.queryByRole('tab', { name: 'Automations' })).toBeNull();
      await waitFor(() => expect(mockList).not.toHaveBeenCalled());
    }
  });

  it.each([true, false])('shows webhook rules only when the flag is %s', async (enabled) => {
    mockParams = { kind: 'webhook' };
    mockFeatures = { workflows: true, webhookRules: enabled };
    await render(<IntegrationRoute />);
    if (enabled) {
      expect(await screen.findByText(webhookRule.name)).toBeVisible();
      expect(mockList).toHaveBeenCalledWith('ws-1', 'webhook');
      expect(screen.getByText('Edit on the web')).toBeVisible();
      expect(screen.getByRole('switch', { name: `${webhookRule.name} automation` })).toBeVisible();
      expect(screen.queryByRole('tab', { name: 'Connection' })).toBeNull();
    } else {
      expect(screen.queryByText(webhookRule.name)).toBeNull();
      await waitFor(() => expect(mockList).not.toHaveBeenCalled());
    }
  });

  it('shows the webhook empty state', async () => {
    mockList.mockResolvedValue([]);
    await render(<RulesScreen kind="workflow" integration="webhook" />);
    expect(await screen.findByText('An automation gets its own URL. A request to it starts a session or a task.')).toBeVisible();
    expect(screen.getByText('Edit on the web')).toBeVisible();
  });

  it('opens a webhook rule as a read-only summary', async () => {
    mockParams = { kind: 'webhook', id: 'webhook-1' };
    mockFeatures = { workflows: true, webhookRules: true };
    mockRuns.mockResolvedValue([{ ...slackRun, integration: 'webhook', event: 'webhook_received', subjectLabel: '', actions: [] , status: 'succeeded' }]);
    await render(<RuleDetailRoute />);
    expect(await screen.findByText('Start a task')).toBeVisible();
    expect(await screen.findByText('Webhook request')).toBeVisible();
    expect(screen.getByText('Edit on the web')).toBeVisible();
  });

  it('opens a Slack rule and shows the reply permission failure', async () => {
    mockParams = { kind: 'slack', id: 'slack-1' };
    await render(<RuleDetailRoute />);
    expect(await screen.findByText('New message in a channel')).toBeVisible();
    expect(screen.getByText('Automation')).toBeVisible();
    expect(screen.queryByText('Who can trigger it')).toBeNull();
    expect(mockList).toHaveBeenCalledWith('ws-1', 'slack');
    expect(await screen.findByText('Slack did not allow this reply. Reinstall Slack to grant the chat:write permission.')).toBeVisible();
    expect(screen.getByText('#support')).toBeVisible();
    expect(screen.queryByText(/repo#null/)).toBeNull();
  });

  it.each([
    ['links the session it started', 'wb-1', [{ pathname: '/sessions/[id]', params: { id: 'wb-1' } }]],
    ['has no session link without a session', null, []],
  ] as const)('%s', async (_name, workbenchId, hrefs) => {
    mockParams = { kind: 'slack', id: 'slack-1' };
    mockRuns.mockResolvedValue([{ ...slackRun, workbenchId, status: 'succeeded',
      actions: [{ type: 'start_session', ok: true, detail: 'started a session' }] }]);
    await render(<RuleDetailRoute />);
    expect(await screen.findByText('#support')).toBeVisible();
    expect([...new Set(mockHrefs.map((href) => JSON.stringify(href)))].map((href) => JSON.parse(href))).toEqual(hrefs);
  });
});
