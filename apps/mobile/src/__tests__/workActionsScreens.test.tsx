import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Keyboard } from 'react-native';

import { NewWorkScreen } from '../features/create/NewWorkScreen';
import { PullRequestDetailScreen } from '../features/prs/PullRequestDetailScreen';
import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { WorkbenchListScreen } from '../features/sessions/WorkbenchListScreen';
import { DetailRoute } from '../navigation/DetailRoute';
import { fixture, pr, session } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
let mockParams: Record<string, string> = { id: 'session-one' };
let mockNetwork = 'online';
let mockWorkspace: { status: string; selected: string | null; choices: unknown[] } = { status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] };
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/sessions/session-one',
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: ({ href }: { href: string }) => { const { Text } = jest.requireActual('react-native'); return <Text>{`Redirect ${href}`}</Text>; },
  useRouter: () => mockRouter,
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) => options?.headerRight?.() ?? null },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }), useNetwork: () => mockNetwork,
  useWorkspace: () => mockWorkspace,
}));
beforeEach(() => {
  mockActive.store.dispose(); mockActive = fixture(); mockParams = { id: 'session-one' }; mockNetwork = 'online';
  mockWorkspace = { status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] };
  Object.values(mockRouter).forEach((value) => { if (jest.isMockFunction(value)) value.mockClear(); });
});
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const confirmLast = async (alert: jest.SpyInstance, label: string) => {
  const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] as Array<{ text: string; onPress?(): void }>;
  await act(async () => buttons.find((button) => button.text === label)?.onPress?.());
};

describe('session controls', () => {
  it('archives from the header menu after a confirmation and leaves the screen', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    expect(screen.getByRole('button', { name: 'Rename' })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Archive' }));
    expect(alert.mock.calls[0][0]).toBe('Archive Current work?');
    expect(mockActive.api.workbenches.archive).not.toHaveBeenCalled();
    await confirmLast(alert, 'Archive');
    expect(mockActive.api.workbenches.archive).toHaveBeenCalledWith('session-one');
    expect(mockRouter.back).toHaveBeenCalled();
  });
  it('shrinks the header to one line while the keyboard is open', async () => {
    const listeners = new Map<string, (event: { endCoordinates: { height: number } }) => void>();
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, listener: (event: { endCoordinates: { height: number } }) => void) => {
      listeners.set(name, listener); return { remove: jest.fn() };
    }) as never);
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByRole('link', { name: 'Open related pull request' })).toBeVisible();
    await act(async () => listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 300 } }));
    expect(screen.getByRole('header', { name: 'Current work' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open related pull request' })).toBeNull();
    await act(async () => listeners.get('keyboardWillHide')?.({ endCoordinates: { height: 0 } }));
    expect(screen.getByRole('link', { name: 'Open related pull request' })).toBeVisible();
  });
  it('renames through the prompt sheet', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Rename' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Better name');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockActive.api.workbenches.update).toHaveBeenCalledWith('session-one', { title: 'Better name' }));
  });
  it('stops a running agent', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ chats: [{ ...session().chats![0], status: 'running' }] }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Stop agent' }));
    await waitFor(() => expect(mockActive.api.workbenches.cancel).toHaveBeenCalledWith('chat-one'));
  });
  it('offers Retry on a failed start and shows a box refusal', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.workbenches.get.mockResolvedValue(session({ status: 'error', error: 'The sandbox did not start.' }));
    mockActive.api.workbenches.retry.mockRejectedValueOnce({ status: 402, code: 'usage_exhausted', details: { notice: { message: 'No box-hours left.' } } });
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByText('The sandbox did not start.')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Out of box-hours', 'No box-hours left. Manage your plan in Talyn on the web.', expect.any(Array)));
  });
  it('disables network actions offline', async () => {
    mockNetwork = 'offline';
    await mockActive.store.load('workbench', 'session-one');
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Share link' })).toBeEnabled();
  });
  it('opens the menu from a long press on a list row', async () => {
    await render(<WorkbenchListScreen kind="session" />);
    const row = await screen.findByRole('link', { name: /Current work/ });
    await fireEvent(row, 'longPress');
    expect(screen.getByRole('header', { name: 'Current work' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeVisible();
  });
  it.each([
    [{ workbenches: true }, true],
    [{ workbenches: false }, false],
    [{}, false],
  ])('shows the new session button for features %j: %s', async (features, shown) => {
    mockActive.api.features.get.mockResolvedValue(features);
    await render(<WorkbenchListScreen kind="session" />);
    await screen.findByRole('link', { name: /Current work/ });
    await waitFor(() => expect(mockActive.api.features.get).toHaveBeenCalled());
    if (shown) {
      await fireEvent.press(await screen.findByRole('button', { name: 'New session' }));
      expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/new', params: { mode: 'session' } });
    } else {
      await act(async () => {});
      expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
    }
  });
});

describe('pull request actions', () => {
  const mine = () => pr({ authored: true, summary: { ...pr().summary, blockingReason: 'mergeable', mergeable: 'MERGEABLE',
    checks: { total: 3, passed: 2, failed: 1, inProgress: 0, skipped: 0 } } });
  beforeEach(() => { mockParams = { id: 'pr-one' }; });

  it('merges after a confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.pullRequests.get.mockResolvedValue({ row: mine(), fresh: null });
    await render(<PullRequestDetailScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Merge' }));
    expect(mockActive.api.pullRequests.merge).not.toHaveBeenCalled();
    await confirmLast(alert, 'Merge');
    expect(mockActive.api.pullRequests.merge).toHaveBeenCalledWith('pr-one');
    expect(await screen.findByText('Merged #42.')).toBeVisible();
    expect(screen.getByText('3 checks: 2 passed, 1 failing')).toBeVisible();
  });
  it('toggles the merge queue and auto-keep', async () => {
    mockActive.api.pullRequests.get.mockResolvedValue({ row: mine(), fresh: null });
    await render(<PullRequestDetailScreen />);
    const queue = await screen.findByLabelText('Merge queue');
    await fireEvent(queue, 'valueChange', true);
    expect(mockActive.api.pullRequests.setMergeQueue).toHaveBeenCalledWith('pr-one', true);
    const keep = await screen.findByLabelText('Keep mergeable');
    await fireEvent(keep, 'valueChange', true);
    expect(mockActive.api.pullRequests.setAutoKeepMergeable).toHaveBeenCalledWith('pr-one', true);
  });
  it('starts a fix with the agent picker when the workspace asks', async () => {
    mockActive.api.pullRequests.get.mockResolvedValue({ row: mine(), fresh: null });
    mockActive.api.workspaces.get.mockResolvedValue({ id: 'one', name: 'Test workspace', settings: { defaultCloudProvider: 'ask' }, repos: [] });
    await render(<PullRequestDetailScreen />);
    await waitFor(() => expect(mockActive.api.workspaces.get).toHaveBeenCalled());
    await fireEvent.press(await screen.findByRole('button', { name: 'Fix with agent' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'PostHog Code' }));
    await waitFor(() => expect(mockActive.api.tasks.create).toHaveBeenCalledWith(expect.objectContaining({ assignedEnvironmentId: 'env-posthog' })));
    expect(await screen.findByText('An agent is working on this pull request.')).toBeVisible();
  });
  it('explains why a clean PR has nothing to fix', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.pullRequests.get.mockResolvedValue({ row: pr({ authored: true, summary: { ...pr().summary, blockingReason: 'mergeable', mergeable: 'MERGEABLE' } }), fresh: null });
    await render(<PullRequestDetailScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Fix with agent\. Nothing to fix/ }));
    expect(alert.mock.calls[0][0]).toBe('Nothing to hand to an agent');
    expect(mockActive.api.tasks.create).not.toHaveBeenCalled();
  });
});

describe('start new work', () => {
  it('starts a session and opens it', async () => {
    await render(<NewWorkScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Task'), 'Fix the flaky test');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(mockActive.api.workbenches.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'one', repositoryId: 'repo-one', runtime: 'sandbox', prompt: 'Fix the flaky test' })));
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/sessions/[id]', params: { id: 'session-new' } });
  });
  it('starts a thread without a repository', async () => {
    await render(<NewWorkScreen initialMode="thread" />);
    await fireEvent.changeText(await screen.findByLabelText('What to get done'), 'Plan the release');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start thread' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Start thread' }));
    await waitFor(() => expect(mockActive.api.workbenches.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'thread' })));
    expect(screen.queryByText('Repository')).toBeNull();
  });
  it('shows web copy when no agent can run', async () => {
    mockActive.api.workbenches.readiness.mockResolvedValue({ sandbox: { ok: true, reasons: [], agents: {
      claude: { ok: false, reason: { code: 'agent_not_connected', message: 'Connect Claude in Settings' } },
      codex: { ok: false, reason: { code: 'agent_not_connected', message: 'Connect Codex in Settings' } } } } });
    await render(<NewWorkScreen />);
    expect(await screen.findByText(/Sandbox unavailable: Connect Claude in Settings/)).toBeVisible();
    await fireEvent.changeText(screen.getByLabelText('Task'), 'Something');
    expect(screen.getByRole('button', { name: /^Start session\./ })).toBeDisabled();
  });
  it('keeps the draft and shows a box refusal', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.workbenches.create.mockRejectedValueOnce({ status: 402, code: 'concurrent_box_limit_reached', message: 'Two boxes already run.' });
    await render(<NewWorkScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Task'), 'Keep me');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByText('Two boxes already run.')).toBeVisible();
    expect(alert.mock.calls[0][0]).toBe('All your boxes are busy');
    expect(screen.getByDisplayValue('Keep me')).toBeVisible();
  });
  it('blocks a start offline', async () => {
    mockNetwork = 'offline';
    await render(<NewWorkScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Task'), 'Later');
    expect(screen.getByRole('button', { name: /^Start session\./ })).toBeDisabled();
  });
  it('says when sessions are not offered', async () => {
    mockActive.api.features.get.mockResolvedValue({ workbenches: false });
    await render(<NewWorkScreen />);
    expect(await screen.findByText('Sessions are not available on this account.')).toBeVisible();
  });
});

describe('detail routes on a cold start', () => {
  it.each([
    [{ status: 'loading', selected: null }, false],
    [{ status: 'idle', selected: null }, false],
    [{ status: 'ready', selected: null }, true],
  ])('with workspace %j redirects: %s', async (snapshot, redirects) => {
    mockWorkspace = { ...snapshot, choices: [] };
    await render(<DetailRoute list="/sessions"><></></DetailRoute>);
    expect(screen.queryByText('Redirect /workspaces') !== null).toBe(redirects);
  });
});
