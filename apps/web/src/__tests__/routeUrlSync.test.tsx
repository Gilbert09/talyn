import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { useRouteUrlSync } from '../hooks/useRouteUrlSync';
import { installNavigation, useNavigationStore, SETTINGS_SECTIONS, type Route } from '../stores/navigation';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { PANEL_PATHS, panelForPath, pathForRoute, routeForPath } from '../lib/routes';
import type { ActivePanel } from '../lib/panels';

let currentPath = '';
let move: NavigateFunction;
function Probe() {
  useRouteUrlSync();
  currentPath = useLocation().pathname;
  move = useNavigate();
  return null;
}
function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
    </MemoryRouter>
  );
}
const setPanel = (panel: ActivePanel) => act(() => useWorkspaceStore.getState().setActivePanel(panel));
const go = (route: Route, replace = false) => act(() => useNavigationStore.getState().navigate(route, { replace }));

beforeEach(() => {
  installNavigation();
  useWorkbenchStore.setState({ workspaceId: null, workbenches: {}, selectedWorkbenchId: null, listLoaded: false });
  useNavigationStore.setState({ route: { view: 'home' }, lastWorkbenchId: null, replace: false });
  useWorkspaceStore.setState({ activePanel: 'workbenches', settingsSection: 'workspace' });
  currentPath = '';
});
afterEach(cleanup);

const routes: Array<[string, Route]> = [
  ['/', { view: 'home' }],
  ['/s/session-1', { view: 'workbench', id: 'session-1' }],
  ['/s/a%20b', { view: 'workbench', id: 'a b' }],
  ['/history', { view: 'history' }],
  ['/prs', { view: 'prs', tab: 'my_prs' }],
  ['/reviews', { view: 'prs', tab: 'reviews' }],
  ['/merge-queue', { view: 'prs', tab: 'merge_queue' }],
  ['/code-reviews', { view: 'prs', tab: 'code_reviews' }],
  ['/queue', { view: 'prs', tab: 'queue' }],
  ['/workflows', { view: 'automations', tab: 'workflows' }],
  ['/loops', { view: 'automations', tab: 'loops' }],
  ['/mcp-servers', { view: 'mcp_servers' }],
  ...SETTINGS_SECTIONS.map((section): [string, Route] => [`/settings/${section}`, { view: 'settings', section }]),
];

describe('route URL sync', () => {
  it.each(routes)('opens the deep link %s', (path, route) => {
    mount(path);
    expect(useNavigationStore.getState().route).toEqual(route);
    expect(currentPath).toBe(path);
    expect(pathForRoute(route)).toBe(path);
  });

  it.each(Object.entries(PANEL_PATHS) as Array<[ActivePanel, string]>)(
    'keeps the panel adapter for %s',
    (panel, path) => {
      mount('/reviews');
      setPanel(panel);
      expect(currentPath).toBe(panel === 'settings' ? '/settings/workspace' : path);
      expect(useWorkspaceStore.getState().activePanel).toBe(panel);
    }
  );

  it('keeps consecutive changes without reverting', () => {
    mount('/prs');
    setPanel('reviews');
    expect(currentPath).toBe('/reviews');
    setPanel('merge_queue');
    expect(currentPath).toBe('/merge-queue');
  });

  it('uses browser back and forward without adding entries', () => {
    mount('/prs');
    go({ view: 'workbench', id: 'one' });
    go({ view: 'history' });
    act(() => move(-1));
    expect(currentPath).toBe('/s/one');
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'one' });
    act(() => move(-1));
    expect(currentPath).toBe('/prs');
    expect(useWorkbenchStore.getState().selectedWorkbenchId).toBeNull();
    act(() => move(1));
    expect(currentPath).toBe('/s/one');
    expect(useWorkbenchStore.getState().selectedWorkbenchId).toBe('one');
  });

  it('replaces an invalid session without a history stop', () => {
    mount('/prs');
    go({ view: 'workbench', id: 'missing' });
    go({ view: 'home' }, true);
    act(() => move(-1));
    expect(currentPath).toBe('/prs');
    act(() => move(1));
    expect(currentPath).toBe('/');
  });

  it('does not add an entry for the same route', () => {
    mount('/prs');
    go({ view: 'history' });
    go({ view: 'history' });
    act(() => move(-1));
    expect(currentPath).toBe('/prs');
  });

  it('updates the URL when Settings changes its section', () => {
    mount('/settings');
    act(() => useWorkspaceStore.getState().setSettingsSection('billing'));
    expect(currentPath).toBe('/settings/billing');
    act(() => move(-1));
    expect(useWorkspaceStore.getState().settingsSection).toBe('workspace');
  });

  it.each(['/bad', '/settings/unknown', '/s/%E0%A4%A', '/s/'])('replaces unknown URL %s with home', (path) => {
    mount(path);
    expect(currentPath).toBe('/');
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it.each(['/settings', '/workbenches', '/reviews/'])('preserves the existing link %s', (path) => {
    mount(path);
    expect(currentPath).toBe(path);
    expect(useNavigationStore.getState().route).toEqual(routeForPath(path));
  });

  it('has no debug route', () => {
    expect(panelForPath('/debug')).toBeNull();
    expect(Object.values(PANEL_PATHS)).not.toContain('/debug');
  });
});
