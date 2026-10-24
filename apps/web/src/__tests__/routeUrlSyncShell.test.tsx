import { Suspense } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { Features } from '@talyn/shared';
import { AppShell, RoutedView } from '../components/layout/AppShell';
import { installNavigation, useNavigationStore, type Route } from '../stores/navigation';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../lib/workbenchData', () => ({ loadWorkbenches: mocks.load }));
vi.mock('../components/layout/AppSidebar', () => ({ AppSidebar: () => null }));
vi.mock('../components/layout/SystemStatusBanner', () => ({ SystemStatusBanner: () => null }));
vi.mock('../components/layout/appShortcuts', () => ({ useAppShortcuts: () => {} }));
vi.mock('../hooks/useSystemStatus', () => ({ useSystemStatus: () => {} }));
vi.mock('../hooks/usePullRequestSync', () => ({ usePullRequestSync: () => {} }));
vi.mock('../hooks/useWhatsNew', () => ({ useWhatsNew: () => {} }));
vi.mock('../hooks/useDeferredRuns', () => ({ useDeferredRuns: () => {} }));
vi.mock('../hooks/useCodeReviewIntro', () => ({ useCodeReviewIntro: () => ({ open: false }) }));
vi.mock('../components/modals/CreateWorkspaceModal', () => ({ CreateWorkspaceModal: () => null }));
vi.mock('../components/modals/UpgradeModal', () => ({ UpgradeModal: () => null }));
vi.mock('../components/modals/ConnectAgentModal', () => ({ ConnectAgentModal: () => null }));
vi.mock('../components/modals/WhatsNewModal', () => ({ WhatsNewModal: () => null }));
vi.mock('../components/modals/CodeReviewIntroModal', () => ({ CodeReviewIntroModal: () => null }));
vi.mock('../components/modals/AddRepositoryModal', () => ({ AddRepositoryModal: () => null }));
vi.mock('../pages/HomePage', () => ({ HomePage: () => <div>Home</div> }));
vi.mock('../pages/HistoryView', () => ({ HistoryView: () => <div>History</div> }));
vi.mock('../pages/WorkbenchPage', () => ({ WorkbenchPage: ({ id }: { id: string }) => <div>Session {id}</div> }));
vi.mock('../pages/PullRequestsView', () => ({ PullRequestsView: () => <div>Pull requests</div> }));
vi.mock('../pages/AutomationsView', () => ({ AutomationsView: () => <div>Automations</div> }));
vi.mock('../components/panels/SettingsPanel', () => ({ SettingsPanel: () => <div>Settings</div> }));

beforeEach(() => {
  installNavigation();
  mocks.load.mockClear();
  useNavigationStore.setState({ route: { view: 'home' }, paletteOpen: false, lastWorkbenchId: null });
  useWorkbenchStore.setState({ workspaceId: null, workbenches: {}, listLoaded: false, selectedWorkbenchId: null });
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1', features: null });
});
afterEach(cleanup);

function Location() {
  return <output>{useLocation().pathname}</output>;
}

describe('shell session gate', () => {
  it.each<Route>([{ view: 'history' }, { view: 'workbench', id: 'one' }, { view: 'settings', section: 'sessions' }])(
    'draws nothing for %p while features load',
    (route) => {
      useNavigationStore.setState({ route });
      const { container } = render(
        <Suspense fallback={null}>
          <RoutedView />
        </Suspense>
      );
      expect(container.textContent).toBe('');
    }
  );

  it('waits for features before fetching the session list', async () => {
    render(
      <MemoryRouter initialEntries={['/s/one']}>
        <AppShell />
        <Location />
      </MemoryRouter>
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(screen.queryByText('Session one')).toBeNull();
    expect(screen.getByText('/s/one')).toBeTruthy();
    act(() => useWorkspaceStore.setState({ features: { workbenches: true } as Features }));
    await screen.findByText('Session one');
    expect(mocks.load).toHaveBeenCalledWith('ws1');
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it('returns home when the backend refuses sessions', async () => {
    render(
      <MemoryRouter initialEntries={['/history']}>
        <AppShell />
        <Location />
      </MemoryRouter>
    );
    act(() => useWorkspaceStore.setState({ features: { workbenches: false } as Features }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('/'));
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
