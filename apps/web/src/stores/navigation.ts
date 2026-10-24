import { create } from 'zustand';
import type { Workbench } from '@talyn/shared';
import { setPanelNavigator, useWorkspaceStore, type SettingsSection } from './workspace';
import { useWorkbenchStore } from './workbenches';
import type { ActivePanel } from '../lib/panels';
import { PR_TABS, type PrTab } from '../lib/prTabs';
export { PR_TABS, type PrTab } from '../lib/prTabs';
export type AutomationTab = 'workflows' | 'loops';

export type Route =
  | { view: 'home' }
  | { view: 'workbench'; id: string }
  | { view: 'history' }
  | { view: 'mcp_servers' }
  | { view: 'prs'; tab: PrTab }
  | { view: 'automations'; tab: AutomationTab }
  | { view: 'settings'; section: SettingsSection };

export const AUTOMATION_TABS: readonly AutomationTab[] = ['workflows', 'loops'];
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'sessions',
  'shortcuts',
  'workspace',
  'integrations',
  'skills',
  'instructions',
  'codeReview',
  'account',
  'billing',
  'teams',
  'appearance',
  'developer',
  'mcp',
  'about',
];

export const HOME: Route = { view: 'home' };

export function isRoute(value: unknown): value is Route {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  switch (r.view) {
    case 'home':
    case 'history':
    case 'mcp_servers':
      return true;
    case 'workbench':
      return typeof r.id === 'string' && r.id.length > 0;
    case 'prs':
      return PR_TABS.includes(r.tab as PrTab);
    case 'automations':
      return AUTOMATION_TABS.includes(r.tab as AutomationTab);
    case 'settings':
      return SETTINGS_SECTIONS.includes(r.section as SettingsSection);
    default:
      return false;
  }
}

export function routesEqual(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function panelForRoute(route: Route): ActivePanel {
  switch (route.view) {
    case 'prs':
    case 'automations':
      return route.tab;
    case 'settings':
      return 'settings';
    case 'mcp_servers':
      return 'mcp_servers';
    default:
      return 'workbenches';
  }
}

export function analyticsPanel(route: Route): string {
  switch (route.view) {
    case 'prs':
    case 'automations':
      return route.tab;
    default:
      return route.view;
  }
}

function isLive(wb: Workbench | undefined): wb is Workbench {
  return wb !== undefined && wb.status !== 'archived' && !wb.archivedAt;
}

export function routeForPanel(
  panel: ActivePanel,
  ctx: { lastWorkbenchId: string | null; workbenches: Record<string, Workbench>; settingsSection: SettingsSection }
): Route {
  switch (panel) {
    case 'my_prs':
    case 'reviews':
    case 'code_reviews':
    case 'merge_queue':
    case 'queue':
      return { view: 'prs', tab: panel };
    case 'workflows':
    case 'loops':
      return { view: 'automations', tab: panel };
    case 'settings':
      return { view: 'settings', section: ctx.settingsSection };
    case 'mcp_servers':
      return { view: 'mcp_servers' };
    case 'workbenches':
    default: {
      const id = ctx.lastWorkbenchId;
      return id && isLive(ctx.workbenches[id]) ? { view: 'workbench', id } : HOME;
    }
  }
}

interface NavigationState {
  route: Route;
  replace: boolean;
  lastWorkbenchId: string | null;
  paletteOpen: boolean;
  addRepositoryOpen: boolean;

  navigate: (route: Route, opts?: { replace?: boolean }) => void;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  setAddRepositoryOpen: (open: boolean) => void;
  reconcileWorkbenchRoute: (input: {
    workbenches: Record<string, Workbench>;
    listLoaded: boolean;
    offered: boolean | null;
  }) => void;
}

function applyRoute(route: Route): void {
  const ws = useWorkspaceStore.getState();
  const patch: Partial<ReturnType<typeof useWorkspaceStore.getState>> = {};
  const panel = panelForRoute(route);
  if (ws.activePanel !== panel) patch.activePanel = panel;
  if (route.view === 'settings' && ws.settingsSection !== route.section) patch.settingsSection = route.section;
  if (Object.keys(patch).length) useWorkspaceStore.setState(patch);

  const wbStore = useWorkbenchStore.getState();
  if (route.view === 'workbench') {
    const known = Boolean(wbStore.workbenches[route.id]);
    if (wbStore.selectedWorkbenchId !== route.id && (known || !wbStore.listLoaded)) {
      wbStore.selectWorkbench(route.id);
    }
  } else if (wbStore.selectedWorkbenchId !== null) {
    wbStore.selectWorkbench(null);
  }
}

const initialRoute = HOME;

export const useNavigationStore = create<NavigationState>((set, get) => ({
  route: initialRoute,
  replace: false,
  lastWorkbenchId: null,
  paletteOpen: false,
  addRepositoryOpen: false,

  navigate: (route, opts) => {
    set({
      route,
      replace: opts?.replace ?? false,
      lastWorkbenchId: route.view === 'workbench' ? route.id : get().lastWorkbenchId,
    });
    applyRoute(route);
  },

  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  setAddRepositoryOpen: (addRepositoryOpen) => set({ addRepositoryOpen }),

  reconcileWorkbenchRoute: ({ workbenches, listLoaded, offered }) => {
    const { route } = get();
    if (route.view !== 'workbench' && route.view !== 'history') return;
    if (offered === false) {
      get().navigate(HOME, { replace: true });
      return;
    }
    if (offered === null || route.view !== 'workbench' || !listLoaded) return;
    if (!isLive(workbenches[route.id])) {
      get().navigate(HOME, { replace: true });
      return;
    }
    if (useWorkbenchStore.getState().selectedWorkbenchId !== route.id) {
      useWorkbenchStore.getState().selectWorkbench(route.id);
    }
  },
}));

let installed = false;

export function installNavigation(): void {
  if (installed) return;
  installed = true;
  setPanelNavigator({
    openPanel: (panel) => {
      const nav = useNavigationStore.getState();
      nav.navigate(
        routeForPanel(panel, {
          lastWorkbenchId: useWorkbenchStore.getState().selectedWorkbenchId ?? nav.lastWorkbenchId,
          workbenches: useWorkbenchStore.getState().workbenches,
          settingsSection: useWorkspaceStore.getState().settingsSection,
        })
      );
    },
    openSettings: (section) => useNavigationStore.getState().navigate({ view: 'settings', section }),
  });
  applyRoute(useNavigationStore.getState().route);
  useWorkbenchStore.subscribe((s, prev) => {
    if (s.selectedWorkbenchId === prev.selectedWorkbenchId) return;
    const nav = useNavigationStore.getState();
    const id = s.selectedWorkbenchId;
    if (id) {
      if (!(nav.route.view === 'workbench' && nav.route.id === id)) nav.navigate({ view: 'workbench', id });
    } else if (nav.route.view === 'workbench' && s.listLoaded) {
      nav.navigate(HOME, { replace: true });
    }
  });
  useWorkspaceStore.subscribe((s, prev) => {
    if (s.settingsSection === prev.settingsSection) return;
    const { route } = useNavigationStore.getState();
    if (route.view === 'settings' && route.section !== s.settingsSection) {
      const next: Route = { view: 'settings', section: s.settingsSection };
      useNavigationStore.getState().navigate(next);
    }
  });
}
