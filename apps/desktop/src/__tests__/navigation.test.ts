import type { Workbench } from '@talyn/shared';
import type { ActivePanel } from '../renderer/stores/workspace';

type NavModule = typeof import('../renderer/stores/navigation');
type WsModule = typeof import('../renderer/stores/workspace');
type WbModule = typeof import('../renderer/stores/workbenches');

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

/** Fresh module instances, so the persisted route is read again at import. */
function load(persisted?: unknown): { nav: NavModule; ws: WsModule; wbs: WbModule } {
  localStorage.clear();
  if (persisted !== undefined) {
    localStorage.setItem('talyn-last-route', typeof persisted === 'string' ? persisted : JSON.stringify(persisted));
  }
  let mods!: { nav: NavModule; ws: WsModule; wbs: WbModule };
  jest.isolateModules(() => {
    mods = {
      nav: require('../renderer/stores/navigation'),
      ws: require('../renderer/stores/workspace'),
      wbs: require('../renderer/stores/workbenches'),
    };
  });
  mods.nav.installNavigation();
  return mods;
}

function seedWorkbenches(wbs: WbModule, list: Workbench[]) {
  wbs.useWorkbenchStore.getState().setWorkspace('ws1');
  wbs.useWorkbenchStore.getState().setWorkbenches('ws1', list);
}

describe('navigation store', () => {
  it('starts at home with nothing persisted', () => {
    const { nav, ws } = load();
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
    expect(ws.useWorkspaceStore.getState().activePanel).toBe('workbenches');
  });

  it('navigate pushes history, and back/forward walk it', () => {
    const { nav } = load();
    const s = () => nav.useNavigationStore.getState();
    s().navigate({ view: 'prs', tab: 'reviews' });
    s().navigate({ view: 'history' });
    expect(s().backStack).toEqual([{ view: 'home' }, { view: 'prs', tab: 'reviews' }]);

    s().back();
    expect(s().route).toEqual({ view: 'prs', tab: 'reviews' });
    expect(s().forwardStack).toEqual([{ view: 'history' }]);
    s().back();
    expect(s().route).toEqual({ view: 'home' });
    s().back();
    expect(s().route).toEqual({ view: 'home' });

    s().forward();
    s().forward();
    expect(s().route).toEqual({ view: 'history' });
    s().forward();
    expect(s().route).toEqual({ view: 'history' });
  });

  it('a new navigation clears the forward stack', () => {
    const { nav } = load();
    const s = () => nav.useNavigationStore.getState();
    s().navigate({ view: 'history' });
    s().back();
    s().navigate({ view: 'prs', tab: 'queue' });
    expect(s().forwardStack).toEqual([]);
  });

  it('navigating to the current route adds no history entry', () => {
    const { nav } = load();
    const s = () => nav.useNavigationStore.getState();
    s().navigate({ view: 'history' });
    s().navigate({ view: 'history' });
    expect(s().backStack).toHaveLength(1);
  });

  it('replace swaps the route without a history entry', () => {
    const { nav } = load();
    const s = () => nav.useNavigationStore.getState();
    s().navigate({ view: 'history' });
    s().navigate({ view: 'prs', tab: 'my_prs' }, { replace: true });
    expect(s().route).toEqual({ view: 'prs', tab: 'my_prs' });
    expect(s().backStack).toEqual([{ view: 'home' }]);
  });

  it('caps the back stack', () => {
    const { nav } = load();
    const s = () => nav.useNavigationStore.getState();
    for (let i = 0; i < nav.HISTORY_LIMIT + 10; i += 1) {
      s().navigate({ view: 'workbench', id: `wb${i}` });
    }
    expect(s().backStack).toHaveLength(nav.HISTORY_LIMIT);
  });

  it('persists the route', () => {
    const { nav } = load();
    nav.useNavigationStore.getState().navigate({ view: 'automations', tab: 'loops' });
    expect(JSON.parse(localStorage.getItem('talyn-last-route') ?? 'null')).toEqual({
      view: 'automations',
      tab: 'loops',
    });
  });

  it.each([
    ['garbage', 'not json'],
    ['an unknown view', { view: 'inbox' }],
    ['a bad tab', { view: 'prs', tab: 'nope' }],
    ['a bad settings section', { view: 'settings', section: 'nope' }],
    ['a workbench with no id', { view: 'workbench', id: '' }],
  ])('falls back to home for %s', (_label, persisted) => {
    const { nav } = load(persisted);
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('restores a persisted route and derives the panel from it', () => {
    const { nav, ws } = load({ view: 'settings', section: 'billing' });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'settings', section: 'billing' });
    expect(ws.useWorkspaceStore.getState().activePanel).toBe('settings');
    expect(ws.useWorkspaceStore.getState().settingsSection).toBe('billing');
  });

  it('a persisted workbench route whose workbench is gone falls back to home', () => {
    const { nav, wbs } = load({ view: 'workbench', id: 'deleted' });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'deleted' });
    seedWorkbenches(wbs, [wb('other')]);
    const { workbenches, listLoaded } = wbs.useWorkbenchStore.getState();
    nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches, listLoaded, offered: true });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('a persisted workbench route that still exists selects the workbench once the list loads', () => {
    const { nav, wbs } = load({ view: 'workbench', id: 'keep' });
    seedWorkbenches(wbs, [wb('keep')]);
    const { workbenches, listLoaded } = wbs.useWorkbenchStore.getState();
    nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches, listLoaded, offered: true });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'keep' });
    expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBe('keep');
  });

  it('an archived workbench route goes home', () => {
    const { nav, wbs } = load({ view: 'workbench', id: 'old' });
    seedWorkbenches(wbs, [wb('old', { status: 'archived', archivedAt: '2026-10-13T01:00:00Z' })]);
    const { workbenches, listLoaded } = wbs.useWorkbenchStore.getState();
    nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches, listLoaded, offered: true });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('waits for the list before judging a workbench route', () => {
    const { nav, wbs } = load({ view: 'workbench', id: 'pending' });
    nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches: {}, listLoaded: false, offered: null });
    expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'pending' });
    expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBeNull();
  });

  it.each([{ view: 'workbench', id: 'x' }, { view: 'history' }])(
    'leaves %p when workbenches are not offered',
    (route) => {
      const { nav } = load(route);
      nav.useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches: {}, listLoaded: false, offered: false });
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
    }
  );

  describe('workbench selection follows the route', () => {
    it('navigating to a workbench selects it, and leaving clears it', () => {
      const { nav, wbs } = load();
      seedWorkbenches(wbs, [wb('a')]);
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBe('a');
      nav.useNavigationStore.getState().navigate({ view: 'history' });
      expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBeNull();
      nav.useNavigationStore.getState().back();
      expect(wbs.useWorkbenchStore.getState().selectedWorkbenchId).toBe('a');
    });

    it('a direct selectWorkbench(id) becomes a navigation', () => {
      const { nav, wbs } = load();
      seedWorkbenches(wbs, [wb('a'), wb('b')]);
      wbs.useWorkbenchStore.getState().selectWorkbench('b');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'b' });
      expect(nav.useNavigationStore.getState().backStack).toEqual([{ view: 'home' }]);
    });

    it('selectWorkbench(null) on a workbench route goes home without a history entry', () => {
      const { nav, wbs } = load();
      seedWorkbenches(wbs, [wb('a')]);
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      wbs.useWorkbenchStore.getState().selectWorkbench(null);
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
      expect(nav.useNavigationStore.getState().backStack).toEqual([{ view: 'home' }]);
    });

    it('a workspace switch does not bounce home before the new list loads', () => {
      const { nav, wbs } = load();
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
      ['workbenches', { view: 'home' }],
    ])('setActivePanel(%s) navigates to %p and derives the panel back', (panel, route) => {
      const { nav, ws } = load();
      ws.useWorkspaceStore.getState().setActivePanel(panel);
      expect(nav.useNavigationStore.getState().route).toEqual(route);
      expect(ws.useWorkspaceStore.getState().activePanel).toBe(panel);
    });

    it("setActivePanel('workbenches') reopens the last live workbench", () => {
      const { nav, ws, wbs } = load();
      seedWorkbenches(wbs, [wb('a')]);
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      nav.useNavigationStore.getState().navigate({ view: 'prs', tab: 'reviews' });
      ws.useWorkspaceStore.getState().setActivePanel('workbenches');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'a' });
    });

    it("setActivePanel('workbenches') skips an archived last workbench", () => {
      const { nav, ws, wbs } = load();
      seedWorkbenches(wbs, [wb('a')]);
      nav.useNavigationStore.getState().navigate({ view: 'workbench', id: 'a' });
      nav.useNavigationStore.getState().navigate({ view: 'history' });
      wbs.useWorkbenchStore.getState().upsertWorkbench(wb('a', { status: 'archived', archivedAt: 'x' }));
      ws.useWorkspaceStore.getState().setActivePanel('workbenches');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'home' });
    });

    it('openSettings(section) navigates and sets the section; omitted keeps the current one', () => {
      const { nav, ws } = load();
      ws.useWorkspaceStore.getState().openSettings('teams');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'settings', section: 'teams' });
      expect(ws.useWorkspaceStore.getState().settingsSection).toBe('teams');
      nav.useNavigationStore.getState().navigate({ view: 'home' });
      ws.useWorkspaceStore.getState().openSettings();
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'settings', section: 'teams' });
    });

    it("Settings' own section change updates the route without a history entry", () => {
      const { nav, ws } = load();
      ws.useWorkspaceStore.getState().openSettings('account');
      const depth = nav.useNavigationStore.getState().backStack.length;
      ws.useWorkspaceStore.getState().setSettingsSection('billing');
      expect(nav.useNavigationStore.getState().route).toEqual({ view: 'settings', section: 'billing' });
      expect(nav.useNavigationStore.getState().backStack).toHaveLength(depth);
    });
  });

  it.each([
    [{ view: 'home' }, 'home'],
    [{ view: 'workbench', id: 'a' }, 'workbench'],
    [{ view: 'prs', tab: 'reviews' }, 'reviews'],
    [{ view: 'automations', tab: 'loops' }, 'loops'],
    [{ view: 'settings', section: 'about' }, 'settings'],
  ])('analyticsPanel(%p) is %s', (route, expected) => {
    const { nav } = load();
    expect(nav.analyticsPanel(route as never)).toBe(expected);
  });
});
