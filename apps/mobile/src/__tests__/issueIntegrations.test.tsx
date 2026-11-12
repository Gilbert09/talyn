import type { LinearConnection, WorkflowWithStats } from '@talyn/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { CatalogScreen } from '../features/integrations/CatalogScreen';
import { LinearScreen } from '../features/integrations/LinearScreen';
import { RulesScreen } from '../features/integrations/RulesScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockLinearStatus = jest.fn();
const mockLinearConnect = jest.fn();
const mockLinearDisconnect = jest.fn();
const mockList = jest.fn();
const mockUpdate = jest.fn();
const mockOpenReturn = jest.fn();
let mockFeatures: Record<string, boolean> | null = {};
let mockGithub = true;

jest.mock('@talyn/client/native', () => {
  const actual = jest.requireActual('@talyn/client/native');
  return {
    ...actual,
    slack: { getStatus: async () => ({ installations: [], links: [] }) },
    posthog: { getStatus: async () => ({ connected: false }) },
    trunk: { getStatus: async () => ({ connected: false }) },
    linear: {
      getStatus: (...a: unknown[]) => mockLinearStatus(...a), connect: (...a: unknown[]) => mockLinearConnect(...a),
      disconnect: (...a: unknown[]) => mockLinearDisconnect(...a),
    },
    workflows: { ...actual.workflows, list: (...a: unknown[]) => mockList(...a), update: (...a: unknown[]) => mockUpdate(...a) },
  };
});
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'ws-1', choices: [] }),
  useNetwork: () => 'online',
}));
jest.mock('../workflow/hooks', () => ({
  useResource: () => ({ status: 'ready', data: { id: 'ws-1', integrations: { github: { enabled: mockGithub } } }, refresh: jest.fn() }),
}));
jest.mock('../lib/features', () => ({ ...jest.requireActual('../lib/features'), useFeatures: () => mockFeatures }));
jest.mock('../lib/returnTo', () => ({
  appReturnBase: () => 'talyn-mobile://',
  openReturnFlow: (...a: unknown[]) => mockOpenReturn(...a),
}));
jest.mock('expo-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => children }));

const connection = (extra: Partial<LinearConnection> = {}): LinearConnection => ({
  id: 'c1', workspaceId: 'ws-1', organizationId: 'o1', organizationName: 'Acme', urlKey: 'acme', scopes: [], canAssign: true,
  reauthRequiredAt: null, reauthReason: null, createdAt: '2026-11-01T00:00:00Z', ...extra,
});
const rule = { id: 'r1', workspaceId: 'ws-1', integration: 'linear', name: 'Triage issues', enabled: true, events: ['issue_opened'],
  conditions: {}, actions: [{ type: 'start_task', repositoryId: 'repo-1', prompt: 'Fix' }], maxRunsPerPrPerHour: 5, createdAt: '', updatedAt: '',
  stats: { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null } } as unknown as WorkflowWithStats;

beforeEach(() => {
  jest.restoreAllMocks();
  mockFeatures = {};
  mockGithub = true;
  mockLinearStatus.mockResolvedValue({ configured: true, connections: [] });
  mockLinearConnect.mockResolvedValue({ authorizeUrl: 'https://linear.app/oauth/authorize?x=1' });
  mockLinearDisconnect.mockResolvedValue(undefined);
  mockOpenReturn.mockResolvedValue('returned');
  mockList.mockResolvedValue([rule]);
  mockUpdate.mockImplementation(async (_id: string, input: { enabled?: boolean }) => ({ ...rule, enabled: input.enabled ?? rule.enabled }));
});

describe('issue integration cards', () => {
  it.each([
    [{ workflows: true, issueRules: false }, true, false, false],
    [{ workflows: true, issueRules: true }, false, false, true],
    [{ workflows: true, issueRules: true }, true, true, true],
    [{ workflows: false, issueRules: true }, true, false, false],
  ] as const)('with %j and GitHub connected %s: GitHub Issues %s, Linear %s', async (features, github, issues, linearCard) => {
    mockFeatures = { ...features };
    mockGithub = github;
    await render(<CatalogScreen />);
    expect(await screen.findByText('GitHub')).toBeVisible();
    await waitFor(() => expect(screen.queryByText('GitHub Issues') !== null).toBe(issues));
    expect(screen.queryByText('Linear') !== null).toBe(linearCard);
  });
});

describe('Linear connection', () => {
  it('offers to connect when nothing is connected', async () => {
    await render(<LinearScreen />);
    expect(await screen.findByText('No Linear organization is connected.')).toBeVisible();
    fireEvent.press(screen.getByRole('button', { name: 'Connect Linear' }));
    await waitFor(() => expect(mockOpenReturn).toHaveBeenCalledWith('https://linear.app/oauth/authorize?x=1', 'linear', expect.any(Function)));
    expect(mockLinearConnect).toHaveBeenCalledWith({ workspaceId: 'ws-1', returnTo: 'talyn-mobile://' });
  });

  it('says when the server has no Linear app', async () => {
    mockLinearStatus.mockResolvedValue({ configured: false, connections: [] });
    await render(<LinearScreen />);
    expect(await screen.findByText('Linear is not set up')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connect Linear' })).toBeNull();
  });

  it('shows a connected organization and disconnects it after confirming', async () => {
    mockLinearStatus.mockResolvedValue({ configured: true, connections: [connection()] });
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => { buttons?.find((b) => b.style === 'destructive')?.onPress?.(); });
    await render(<LinearScreen />);
    expect(await screen.findByText('Acme')).toBeVisible();
    expect(screen.getByText('Connected')).toBeVisible();
    fireEvent.press(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mockLinearDisconnect).toHaveBeenCalledWith('ws-1', 'c1'));
  });

  it('asks to reconnect when Linear ended the grant', async () => {
    mockLinearStatus.mockResolvedValue({ configured: true, connections: [connection({ reauthRequiredAt: '2026-11-10T00:00:00Z', reauthReason: 'Linear revoked access.' })] });
    await render(<LinearScreen />);
    expect(await screen.findByText('Reconnect needed')).toBeVisible();
    expect(screen.getByText('Linear revoked access.')).toBeVisible();
    fireEvent.press(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(mockLinearConnect).toHaveBeenCalled());
  });
});

describe('issue rules list', () => {
  it.each(['linear', 'github_issues'] as const)('lists %s rules and toggles one', async (integration) => {
    await render(<RulesScreen kind="workflow" integration={integration} />);
    expect(await screen.findByText('Triage issues')).toBeVisible();
    expect(mockList).toHaveBeenCalledWith('ws-1', integration);
    expect(screen.getByText('Edit on the web')).toBeVisible();
    fireEvent(screen.getByRole('switch', { name: 'Triage issues automation' }), 'valueChange', false);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('r1', expect.objectContaining({ enabled: false })));
  });
});
