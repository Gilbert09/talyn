import { describe, it, expect, vi } from 'vitest';
import type { Workbench } from '@talyn/shared';
import type { ActivePanel } from '../lib/panels';

type NavModule = typeof import('../stores/navigation');
type WsModule = typeof import('../stores/workspace');
type WbModule = typeof import('../stores/workbenches');

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: id,
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    deviceId: null,
    localPath: null,
    sandboxId: null,
    sandboxState: 'running',
    status: 'ready',
    pullRequestId: null,
    settings: {},
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

async function load(route?: unknown): Promise<{ nav: NavModule; ws: WsModule; wbs: WbModule }> {
  vi.resetModules();
  localStorage.clear();
  const nav = await import('../stores/navigation');
  const ws = await import('../stores/workspace');
  const wbs = await import('../stores/workbenches');
  nav.installNavigation();
  if (route && nav.isRoute(route)) nav.useNavigationStore.getState().navigate(route);
  return { nav, ws, wbs };
}

function seedWorkbenches(wbs: WbModule, list: Workbench[]) {
  wbs.useWorkbenchStore.getState().setWorkspace('ws1');
  wbs.useWorkbenchStore.getState().setWorkbenches('ws1', list);
}

describe('navigation store', () => {
  it('starts at home with nothing persisted', async () => {
    const { nav, ws } = await load();
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
    expect(ws.useWorkspaceStore.getState().activePanel).toBe('workbenches');
  });

  it('does not persist routes or maintain history stacks', async () => {
    const { nav } = await load();
    nav.useNavigationStore.getState().navigate({ view: 'history' });
    expect(localStorage.getItem('talyn-last-route')).toBeNull();
    expect(nav.useNavigationStore.getState()).not.toHaveProperty('backStack');
    expect(nav.useNavigationStore.getState()).not.toHaveProperty('forwardStack');
  });

  it('a workbench route whose workbench is gone falls back to home', async () => {
    const { nav, wbs } = await load({ view: 'workbench', id: 'deleted' });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'deleted' });
    seedWorkbenches(wbs, [wb('other')]);
    const { workbenches, listLoaded } = wbs.useWorkbenchStore.getState();
    nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches, listLoaded, offered: true });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('a workbench route that still exists selects the workbench once the list loads', async () => {
    const { nav, wbs } = await load({ view: 'workbench', id: 'keep' });
    seedWorkbenches(wbs, [wb('keep')]);
    const { workbenches, listLoaded } = wbs.useWorkbenchStore.getState();
    nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches, listLoaded, offered: true });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'keep' });
    expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBe('keep');
  });

  it('an archived workbench route goes home', async () => {
    const { nav, wbs } = await load({ view: 'workbench', id: 'old' });
    seedWorkbenches(wbs, [wb('old', { status: 'archived', archivedAt: '2026-10-13T01:00:00Z' })]);
    const { workbenches, listLoaded } = wbs.useWorkbenchStore.getState();
    nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches, listLoaded, offered: true });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('waits for the list before judging a workbench route', async () => {
    const { nav, wbs } = await load({ view: 'workbench', id: 'pending' });
    nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches: {}, listLoaded: false, offered: null });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'pending' });
    expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBe('pending');
  });

  it.each([{ view: 'workbench', id: 'x' }, { view: 'history' }])(
    'leaves %p when workbenches are not offered',
    async (route) => {
      const { nav } = await load(route);
      nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches: {}, listLoaded: false, offered: false });
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
    }
  );

  describe('workbench selection follows the route', () => {
    it('navigating to a workbench selects it, and leaving clears it', async () => {
      const { nav, wbs } = await load();
      seedWorkbenches(wbs, [wb('a')]);
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBe('a');
      nav.useNavigationStore.getState().navigate({ view: 'history' });
      expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBeNull();
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBe('a');
    });

    it('a direct selectWorkbench(id) becomes a navigation', async () => {
      const { nav, wbs } = await load();
      seedWorkbenches(wbs, [wb('a'), wb('b')]);
      wbs.useWorkbenchStore.getState().selectWorkbench('b');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'b' });
    });

    it('selectWorkbench(null) on a workbench route goes home without a history entry', async () => {
      const { nav, wbs } = await load();
      seedWorkbenches(wbs, [wb('a')]);
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      wbs.useWorkbenchStore.getState().selectWorkbench(null);
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
    });

    it('a workspace switch does not bounce home before the new list loads', async () => {
      const { nav, wbs } = await load();
      seedWorkbenches(wbs, [wb('a')]);
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      wbs.useWorkbenchStore.getState().setWorkspace('ws2');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'a' });
      wbs.useWorkbenchStore.getState().setWorkbenches('ws2', []);
      const { workbenches, listLoaded } = wbs.useWorkbenchStore.getState();
      nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches, listLoaded, offered: true });
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
    });
  });

  describe('setActivePanel / openSettings adapter', () => {
    it.each<[ActivePanel, unknown]>([
      ['my_prs', { view: 'prs', tab: 'my_prs' }],
      ['reviews', { view: 'prs', tab: 'reviews' }],
      ['code_reviews', { view: 'prs', tab: 'code_reviews' }],
      ['merge_queue', { view: 'prs', tab: 'merge_queue' }],
      ['queue', { view: 'prs', tab: 'queue' }],
      ['workflows', { view: 'automations', tab: 'workflows' }],
      ['loops', { view: 'automations', tab: 'loops' }],
      ['settings', { view: 'settings', section: 'workspace' }],
      ['mcp_servers', { view: 'mcp_servers' }],
      ['workbenches', { view: 'home' }],
    ])('setActivePanel(%s) navigates to %p and derives the panel back', async (panel, route) => {
      const { nav, ws } = await load();
      ws.useWorkspaceStore.getState().setActivePanel(panel);
      expect(nav.useNavigationStore.getState().route).toEqual(route);
      expect(ws.useWorkspaceStore.getState().activePanel).toBe(panel);
    });

    it("setActivePanel('workbenches') reopens the last live workbench", async () => {
      const { nav, ws, wbs } = await load();
      seedWorkbenches(wbs, [wb('a')]);
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      nav.useNavigationStore.getState().navigate({ view: 'prs', tab: 'reviews' });
      ws.useWorkspaceStore.getState().setActivePanel('workbenches');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'a' });
    });

    it("setActivePanel('workbenches') skips an archived last workbench", async () => {
      const { nav, ws, wbs } = await load();
      seedWorkbenches(wbs, [wb('a')]);
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      nav.useNavigationStore.getState().navigate({ view: 'history' });
      wbs.useWorkbenchStore.getState().upsertWorkbench(wb('a', { status: 'archived', archivedAt: 'x' }));
      ws.useWorkspaceStore.getState().setActivePanel('workbenches');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
    });

    it('openSettings(section) navigates and sets the section; omitted keeps the current one', async () => {
      const { nav, ws } = await load();
      ws.useWorkspaceStore.getState().openSettings('teams');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'settings', section: 'teams' });
      expect(ws.useWorkspaceStore.getState().settingsSection).toBe('teams');
      nav.useNavigationStore.getState().navigate({ view: 'home' });
      ws.useWorkspaceStore.getState().openSettings();
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'settings', section: 'teams' });
    });

    it("Settings' own section change updates the route", async () => {
      const { nav, ws } = await load();
      ws.useWorkspaceStore.getState().openSettings('account');
      ws.useWorkspaceStore.getState().setSettingsSection('billing');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'settings', section: 'billing' });
    });
  });

  it.each([
    [{ view: 'home' }, 'home'],
    [{ view: 'workbench', id: 'a' }, 'workbench'],
    [{ view: 'prs', tab: 'reviews' }, 'reviews'],
    [{ view: 'automations', tab: 'loops' }, 'loops'],
    [{ view: 'settings', section: 'about' }, 'settings'],
  ])('analyticsPanel(%p) is %s', async (route, expected) => {
    const { nav } = await load();
    expect(nav.analyticsPanel(route as never)).toBe(expected);
  });
});
