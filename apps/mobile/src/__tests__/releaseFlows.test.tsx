import { act, render, screen } from '@testing-library/react-native';
import { defaultMobileNotificationPreferences } from '@talyn/shared';
import type { Session } from '@supabase/supabase-js';

import { AccountActions } from '../auth/account';
import { AuthController, type AuthGateway } from '../auth/controller';
import { SecureSessionStorage } from '../auth/storage';
import { clearIntent, consumeIntent, rememberIntent } from '../navigation/intents';
import { NotificationController, type PushDevice, type PushGateway } from '../notifications/controller';
import { WorkspaceController } from '../workspaces/controller';
import { AttentionScreen } from '../features/prs/AttentionScreen';
import { PullRequestDetailScreen } from '../features/prs/PullRequestDetailScreen';
import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { WorkbenchListScreen } from '../features/sessions/WorkbenchListScreen';
import { fixture, scope, session as workbench } from './workflowFixtures';

let mockActive: ReturnType<typeof fixture>;
let mockWorkspace: WorkspaceController;
let mockParams = { id: 'session-one' };
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams, Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }), Stack: { Screen: () => null } }));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }),
  useWorkspace: () => mockWorkspace.getSnapshot(),
  useNetwork: () => mockActive.lifecycle.getSnapshot().reachability,
}));

async function releaseFixture(workspaceId = 'one') {
  mockActive = fixture(); mockActive.store.setScope(null);
  const secure = new Map<string, string>(); const preferences = new Map<string, string>(); let revision = 0;
  const storage = new SecureSessionStorage({ getItemAsync: async (key) => secure.get(key) ?? null,
    setItemAsync: async (key, value) => { secure.set(key, value); }, deleteItemAsync: async (key) => { secure.delete(key); } }, 'release-fixture', () => `${++revision}`);
  mockWorkspace = new WorkspaceController({ getItem: async (key) => preferences.get(key) ?? null,
    setItem: async (key, value) => { preferences.set(key, value); }, removeItem: async (key) => { preferences.delete(key); } }, scope.environment,
  async () => [{ id: workspaceId, name: 'Fixture workspace' }, { id: 'two', name: 'Second workspace' }]);
  const session: Session = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600,
    user: { id: scope.user, email: 'fixture@example.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } };
  const gateway: jest.Mocked<AuthGateway> = {
    getSession: jest.fn(async () => ({ data: { session: null }, error: null })),
    refreshSession: jest.fn(async () => ({ data: { session }, error: null })),
    signInWithOAuth: jest.fn<ReturnType<AuthGateway['signInWithOAuth']>, Parameters<AuthGateway['signInWithOAuth']>>(async () => { await storage.setItem('session-code-verifier', 'fixture-verifier'); return { data: { url: 'https://auth.example.test/authorize' }, error: null }; }),
    exchangeCodeForSession: jest.fn<ReturnType<AuthGateway['exchangeCodeForSession']>, Parameters<AuthGateway['exchangeCodeForSession']>>(async () => ({ data: { session }, error: null })), signOut: jest.fn<ReturnType<AuthGateway['signOut']>, Parameters<AuthGateway['signOut']>>(async () => ({ error: null })), startAutoRefresh: jest.fn(), stopAutoRefresh: jest.fn(),
  };
  const callback = 'talyn-mobile-development://auth/callback';
  const auth = new AuthController(gateway, storage, { open: async () => ({ type: 'success', url: `${callback}?code=fixture` }), dismiss: jest.fn() }, callback,
    async (user) => { mockActive.store.setScope(null); await mockWorkspace.clear(user); if (user) clearIntent(); });
  const sync = () => {
    const user = auth.getSnapshot().user?.id; const workspace = mockWorkspace.getSnapshot().selected;
    mockActive.store.setScope(user && workspace ? { ...scope, user, workspace } : null);
  };
  auth.subscribe(sync); mockWorkspace.subscribe(sync); await auth.restore();
  return { auth, gateway, secure, preferences };
}

afterEach(() => { mockActive?.store.dispose(); clearIntent(); });

describe('deterministic release journeys', () => {
  it('signs in, validates a workspace, reads sessions, threads, and PRs, then logs out', async () => {
    const { auth, gateway, preferences } = await releaseFixture();
    rememberIntent('talyn-mobile-development://sessions/session-one');
    expect(mockActive.store.getScope()).toBeNull(); expect(auth.getSnapshot().status).toBe('signedOut');
    await auth.signIn(); expect(gateway.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    await mockWorkspace.load(scope.user); expect(mockActive.store.getScope()).toBeNull();
    await mockWorkspace.select('one'); expect(consumeIntent()).toBe('/sessions/session-one');
    let view = await render(<WorkbenchListScreen kind="session" />);
    expect(await screen.findByRole('link', { name: /Current work/ })).toBeVisible(); await view.unmount();
    view = await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByText('Agent response 1')).toBeVisible(); await view.unmount();
    mockParams = { id: 'thread-one' }; view = await render(<WorkbenchDetailScreen kind="thread" />);
    expect(await screen.findByRole('header', { name: 'Planning work' })).toBeVisible(); await view.unmount();
    view = await render(<AttentionScreen />);
    expect(await screen.findByRole('link', { name: /Review current work/ })).toBeVisible(); await view.unmount();
    mockParams = { id: 'pr-one' }; view = await render(<PullRequestDetailScreen />);
    expect(await screen.findByRole('header', { name: 'Review current work' })).toBeVisible(); await view.unmount();
    mockActive.store.updateLocal('chat-one', { draft: 'Fixture draft' });
    await mockWorkspace.select('two'); expect(mockActive.store.local('chat-one').draft).toBe('');
    await auth.signOut(); expect(mockActive.store.getScope()).toBeNull(); expect(preferences.size).toBe(0);
    expect(auth.getSnapshot().status).toBe('signedOut'); auth.dispose();
  });

  it.each(['logout', 'deletion', 'expiry'] as const)('clears product content at the %s boundary', async (boundary) => {
    const { auth, gateway, secure } = await releaseFixture(); await auth.signIn(); await mockWorkspace.load(scope.user); await mockWorkspace.select('one');
    await mockActive.store.load('workbench', 'session-one');
    mockActive.store.updateLocal('chat-one', { draft: 'Fixture draft' });
    if (boundary === 'deletion') {
      const wipe = jest.fn(async () => {}); const account = new AccountActions(auth, wipe);
      expect(await account.deleteAccount()).toBe('deleted'); expect(wipe).toHaveBeenCalledTimes(1);
    } else if (boundary === 'expiry') {
      gateway.refreshSession.mockResolvedValue({ data: { session: null }, error: { name: 'AuthApiError', status: 401, code: 'session_expired' } });
      expect(await auth.recoverSession()).toBe(false);
    } else await auth.signOut();
    expect(mockActive.store.getScope()).toBeNull(); expect(mockActive.store.local('chat-one').draft).toBe('');
    expect(secure.size).toBe(0); auth.dispose();
  });

  it('resolves a cold notification after sign-in and fetches current authorized state', async () => {
    const workspaceId = '20000000-0000-4000-8000-000000000001';
    const { auth } = await releaseFixture(workspaceId);
    const entityId = '30000000-0000-4000-8000-000000000001';
    const eventId = '40000000-0000-4000-8000-000000000001';
    const destination = { workspaceId, kind: 'session' as const, entityId };
    const api = { getPreferences: jest.fn(async () => ({ preferences: defaultMobileNotificationPreferences('one'), providerAvailable: false })),
      resolveNotification: jest.fn(async () => ({ schemaVersion: 1, eventId, category: 'session_update', destination, expiresAt: '2099-01-01T00:00:00Z' })) };
    mockActive.api.workbenches.get.mockResolvedValue(workbench({ id: entityId, workspaceId }));
    const navigate = jest.fn(); const fetchDestination = jest.fn(async () => {
      await mockActive.store.load('workbench', destination.entityId);
      expect(mockActive.store.read('workbench', destination.entityId).status).toBe('ready');
    });
    const push = new NotificationController(api as unknown as PushGateway, { available: () => false } as PushDevice, () => true, fetchDestination);
    push.setNavigation(navigate, '');
    const payload = { schemaVersion: 1, eventId, category: 'session_update', destination };
    push.receiveTap(payload); expect(navigate).not.toHaveBeenCalled();
    await auth.signIn(); await mockWorkspace.load(scope.user); await mockWorkspace.select(workspaceId);
    await act(async () => { push.setScope({ user: scope.user, workspace: workspaceId }); });
    expect(api.resolveNotification).toHaveBeenCalledTimes(1); expect(fetchDestination).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`/sessions/${entityId}`);
    push.receiveTap(payload); expect(api.resolveNotification).toHaveBeenCalledTimes(1); push.dispose(); auth.dispose();
  });
});
