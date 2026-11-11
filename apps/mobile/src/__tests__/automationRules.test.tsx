import type { WorkflowRun, WorkflowWithStats } from '@talyn/shared';
import { render, screen, waitFor } from '@testing-library/react-native';

import IntegrationRoute from '../../app/integrations/[kind]';
import RuleDetailRoute from '../../app/integrations/[kind]/[id]';
import { RulesScreen } from '../features/integrations/RulesScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockList = jest.fn();
const mockRuns = jest.fn();
let mockParams: { kind: string; id?: string } = { kind: 'slack' };
let mockFeatures = { workbenches: true, workflows: true, slackChannelRules: true };

jest.mock('@talyn/client/native', () => {
  const actual = jest.requireActual('@talyn/client/native');
  return { ...actual, workflows: { ...actual.workflows,
    list: (...args: unknown[]) => mockList(...args), runs: (...args: unknown[]) => mockRuns(...args),
  } };
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
  Link: ({ children }: { children: React.ReactNode }) => children,
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
  mockList.mockImplementation(async (_workspace: string, integration: string) => integration === 'slack' ? [slackRule] : [githubRule]);
  mockRuns.mockResolvedValue([slackRun]);
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

  it('shows the Slack empty state and web link', async () => {
    mockList.mockResolvedValue([]);
    await render(<RulesScreen kind="workflow" integration="slack" />);
    expect(await screen.findByText('No Slack rules yet')).toBeVisible();
    expect(screen.getByText('A Slack rule starts a session or replies when a message arrives in a channel.')).toBeVisible();
    expect(screen.getByText('Create and edit Slack rules in Talyn on the web.')).toBeVisible();
    expect(screen.getByText('Edit on the web')).toBeVisible();
  });

  it.each([true, false])('shows Slack rules only when the flag is %s', async (enabled) => {
    mockFeatures = { ...mockFeatures, slackChannelRules: enabled };
    await render(<IntegrationRoute />);
    if (enabled) {
      expect(await screen.findByText(slackRule.name)).toBeVisible();
      expect(screen.getByRole('tab', { name: 'Rules' })).toBeVisible();
      expect(screen.getByRole('tab', { name: 'Connection' })).toBeVisible();
      expect(mockList).toHaveBeenCalledWith('ws-1', 'slack');
    } else {
      expect(screen.queryByRole('tab', { name: 'Rules' })).toBeNull();
      await waitFor(() => expect(mockList).not.toHaveBeenCalled());
    }
  });

  it('opens a Slack rule and shows the reply permission failure', async () => {
    mockParams = { kind: 'slack', id: 'slack-1' };
    await render(<RuleDetailRoute />);
    expect(await screen.findByText('New message in a channel')).toBeVisible();
    expect(mockList).toHaveBeenCalledWith('ws-1', 'slack');
    expect(await screen.findByText('Slack did not allow this reply. Reinstall Slack to grant the chat:write permission.')).toBeVisible();
    expect(screen.getByText('#support')).toBeVisible();
    expect(screen.queryByText(/repo#null/)).toBeNull();
  });
});
