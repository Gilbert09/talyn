import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { SpaceSessionRow, SpacesTeam, SpaceTaskRow } from '@talyn/shared';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { NavDrawer } from '../features/nav/NavDrawer';
import { ContextController, contextKey } from '../workspaces/context';
import { fixture, scope, session, thread } from './workflowFixtures';

let mockActive: ReturnType<typeof fixture>;
let mockContext: ContextController;
const mockPrefs = new Map<string, string>();
const mockWorkspace = { status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Fixture workspace' }, { id: 'two', name: 'Side' }] };
const mockWorkspaceController = { getSnapshot: () => mockWorkspace, select: jest.fn(async () => {}), subscribe: () => () => {} };

const creator = (login: string) => ({ userId: `user-${login}`, githubLogin: login, avatarUrl: null });
const spaceRow = (patch: Partial<SpaceSessionRow>): SpaceSessionRow => ({ id: 'x', spaceId: 'space-design', workspaceId: 'one', kind: 'session',
  threadId: null, name: 'x', title: null, status: 'ready', sandboxState: 'running', running: false, repoFullName: 'acme/app', branch: 'b',
  baseBranch: 'main', agent: 'claude', model: null, pullRequest: null, creator: creator('tom'), lastActivityAt: null, archivedAt: null,
  createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T10:00:00Z', ...patch } as SpaceSessionRow);
const mockTeams: SpacesTeam[] = [{ id: 'team-acme', name: 'Acme', role: 'member', homeWorkspaceId: 'one', createdAt: '2026-11-01T00:00:00Z',
  spaces: [{ id: 'space-design', teamId: 'team-acme', name: 'Design', color: '#336699', image: null, createdByUserId: null, archivedAt: null,
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }] }];
const mockSessions = { items: [
  spaceRow({ id: 'mine', title: 'My space session', createdAt: '2026-11-08T09:00:00Z' }),
  spaceRow({ id: 'theirs', workspaceId: 'ben-workspace', title: 'Teammate session', running: true, creator: creator('ben') }),
], hiddenCount: 1 };
const mockTasks: { items: SpaceTaskRow[]; hiddenCount: number } = { items: [], hiddenCount: 0 };

jest.mock('@talyn/client/native', () => ({
  ...jest.requireActual('@talyn/client/native'),
  teams: { list: jest.fn(async () => mockTeams), members: jest.fn(async () => []) },
  spaces: { sessions: jest.fn(async () => mockSessions), tasks: jest.fn(async () => mockTasks), repositories: jest.fn(async () => []) },
  wsClient: { on: jest.fn(() => () => {}), subscribeSpace: jest.fn(), unsubscribeSpace: jest.fn(), sendPresence: jest.fn() },
}));
jest.mock('expo-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true }),
  usePathname: () => '/home', useGlobalSearchParams: () => ({}) }));
jest.mock('../features/usage/data', () => ({ useBillingStatus: () => ({ status: 'idle', data: undefined, stale: false, refreshing: false }) }));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store, lifecycle: mockActive.lifecycle, workspace: mockWorkspaceController, context: mockContext }),
  useAuth: () => ({ user: { id: 'user-tom' } }),
  useWorkspace: () => mockWorkspace,
  useNetwork: () => 'online',
}));

const insets = { frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

beforeEach(async () => {
  mockPrefs.clear();
  mockActive = fixture();
  mockActive.api.features.get.mockResolvedValue({ workbenches: true, spaces: true });
  mockActive.api.workbenches.list.mockResolvedValue([session(), thread(),
    session({ id: 'mine', title: 'My space session', spaceId: 'space-design', chats: [] }),
    session({ id: 'orphan', title: 'Orphan session', spaceId: 'archived-space', chats: [] }),
    { ...thread(), id: 'space-thread', title: 'Space thread', spaceId: 'space-design' }]);
  mockContext = new ContextController({ getItem: async (key) => mockPrefs.get(key) ?? null,
    setItem: async (key, value) => { mockPrefs.set(key, value); }, removeItem: async (key) => { mockPrefs.delete(key); } }, scope.environment);
  await mockContext.load('user-tom');
});
afterEach(() => { mockActive.store.dispose(); });

describe('space switcher', () => {
  it('switches the drawer to a space and lists its items', async () => {
    await render(<SafeAreaProvider initialMetrics={insets}><NavDrawer close={jest.fn()} /></SafeAreaProvider>);
    expect(await screen.findByRole('link', { name: /Current work/ })).toBeVisible();
    // Personal leaves out what is in a space, and keeps what is in a space that is gone.
    expect(await screen.findByRole('link', { name: /Orphan session/ })).toBeVisible();
    expect(screen.queryByText('My space session')).toBeNull();
    expect(screen.queryByText('Space thread')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Workspace: Fixture workspace' })); });
    expect(await screen.findByRole('header', { name: 'Switch workspace or space' })).toBeVisible();
    expect(screen.getByRole('header', { name: 'Personal' })).toBeVisible();
    expect(screen.getByRole('header', { name: 'Acme' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Workspace: Fixture workspace' , selected: true })).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Space: Design' })); });

    expect(await screen.findByRole('button', { name: 'Space: Design, Acme' })).toBeVisible();
    expect(await screen.findByText('My space session')).toBeVisible();
    expect(screen.getByText('Teammate session')).toBeVisible();
    expect(screen.getByRole('link', { name: /Teammate session\. Working\. ben\. Opens on the web\./ })).toBeVisible();
    expect(screen.getByText("1 item you can't see")).toBeVisible();
    expect(screen.queryByRole('link', { name: /Current work/ })).toBeNull();
    await waitFor(() => { expect(mockPrefs.get(contextKey(scope.environment, 'user-tom'))).toBe('space-design'); });
  });

  it('restores a saved space and goes back to Personal from the switcher', async () => {
    await act(async () => { await mockContext.select('space-design'); });
    await render(<SafeAreaProvider initialMetrics={insets}><NavDrawer close={jest.fn()} /></SafeAreaProvider>);
    expect(await screen.findByText('My space session')).toBeVisible();

    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Space: Design, Acme' })); });
    expect(await screen.findByRole('button', { name: 'Space: Design', selected: true })).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Workspace: Fixture workspace' })); });
    expect(await screen.findByRole('link', { name: /Current work/ })).toBeVisible();
    expect(screen.queryByText('My space session')).toBeNull();
    expect(mockContext.getSnapshot().spaceId).toBeNull();
    expect(mockWorkspaceController.select).not.toHaveBeenCalled();
  });
});
