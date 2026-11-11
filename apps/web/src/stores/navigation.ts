import { create } from 'zustand';
import { isIntegrationKind, type IntegrationKind, type Workbench } from '@talyn/shared';
import { contextsEqual, setPanelNavigator, useWorkspaceStore, type AppContext, type SettingsSection } from './workspace';
import { useWorkbenchStore } from './workbenches';
import { findSpace, useSpacesStore } from './spaces';
import type { ActivePanel } from '../lib/panels';
import { PR_TABS, type PrTab } from '../lib/prTabs';
export { PR_TABS, type PrTab } from '../lib/prTabs';
export type Route =
  | { view: 'home'; mode?: 'session' | 'thread' }
  | { view: 'workbench'; id: string }
  | { view: 'history' }
  /** Split view: several sessions side by side. The panes are in `stores/splitView.ts`. */
  | { view: 'split' }
  | { view: 'mcp_servers' }
  | { view: 'insights' }
  | { view: 'prs'; tab: PrTab }
  /** The Integrations area: the catalog, or one integration's page. */
  | { view: 'integrations'; kind?: IntegrationKind }
  | { view: 'settings'; section: SettingsSection };

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'sessions',
  'shortcuts',
  'workspace',
  'sandboxSetup',
  'privateRoutes',
  'integrations',
  'skills',
  'instructions',
  'memory',
  'codeReview',
  'account',
  'billing',
  'teams',
  'appearance',
  'developer',
  'mcp',
  'apiTokens',
  'about',
];

export const HOME: Route = { view: 'home' };
export const HISTORY_LIMIT = 50;

export function isRoute(value: unknown): value is Route {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  switch (r.view) {
    case 'home':
    case 'history':
    case 'split':
    case 'mcp_servers':
    case 'insights':
      return true;
    case 'workbench':
      return typeof r.id === 'string' && r.id.length > 0;
    case 'prs':
      return PR_TABS.includes(r.tab as PrTab);
    case 'integrations':
      return r.kind === undefined || isIntegrationKind(r.kind);
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
      return route.tab;
    case 'integrations':
      return 'integrations';
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
    case 'integrations':
      return { view: 'integrations' };
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

/** A place in history: the route and the context (Personal or a space) it showed in. */
export interface HistoryEntry {
  route: Route;
  context: AppContext;
}

function contextNow(): AppContext {
  const ws = useWorkspaceStore.getState();
  return ws.currentContext.kind === 'personal'
    ? { kind: 'personal', workspaceId: ws.currentContext.workspaceId ?? ws.currentWorkspaceId }
    : ws.currentContext;
}

/**
 * Back and forward return to the context an entry showed in. For example, a
 * session that moved the app to its space goes back to the PR list in the
 * first context. Only with Spaces on, and only to a context that still exists.
 */
function restoreContext(context: AppContext): void {
  const ws = useWorkspaceStore.getState();
  if (ws.features?.spaces !== true || contextsEqual(contextNow(), context)) return;
  if (context.kind === 'space' && !findSpace(useSpacesStore.getState().teams, context.spaceId)) return;
  if (context.kind === 'personal' && !(ws.workspaces ?? []).some((w) => w.id === context.workspaceId)) return;
  ws.setContext(context);
}

interface NavigationState {
  route: Route;
  replace: boolean;
  backStack: HistoryEntry[];
  forwardStack: HistoryEntry[];
  lastWorkbenchId: string | null;
  paletteOpen: boolean;
  addRepositoryOpen: boolean;

  navigate: (route: Route, opts?: { replace?: boolean }) => void;
  back: () => void;
  forward: () => void;
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
  backStack: [],
  forwardStack: [],
  lastWorkbenchId: null,
  paletteOpen: false,
  addRepositoryOpen: false,

  navigate: (route, opts) => {
    const cur = get().route;
    const lastWorkbenchId = route.view === 'workbench' ? route.id : get().lastWorkbenchId;
    if (routesEqual(cur, route)) {
      set({ lastWorkbenchId });
    } else if (opts?.replace) {
      set({ route, replace: true, lastWorkbenchId });
    } else {
      set((s) => ({
        route,
        replace: false,
        lastWorkbenchId,
        backStack: [...s.backStack, { route: cur, context: contextNow() }].slice(-HISTORY_LIMIT),
        forwardStack: [],
      }));
    }
    applyRoute(route);
  },

  back: () => {
    const { backStack, route } = get();
    if (backStack.length === 0) return;
    const { route: prev, context } = backStack[backStack.length - 1];
    const here: HistoryEntry = { route, context: contextNow() };
    restoreContext(context);
    set((s) => ({
      route: prev,
      replace: true,
      backStack: s.backStack.slice(0, -1),
      forwardStack: [here, ...s.forwardStack].slice(0, HISTORY_LIMIT),
      lastWorkbenchId: prev.view === 'workbench' ? prev.id : s.lastWorkbenchId,
    }));
    applyRoute(prev);
  },

  forward: () => {
    const { forwardStack, route } = get();
    if (forwardStack.length === 0) return;
    const { route: next, context } = forwardStack[0];
    const here: HistoryEntry = { route, context: contextNow() };
    restoreContext(context);
    set((s) => ({
      route: next,
      replace: true,
      forwardStack: s.forwardStack.slice(1),
      backStack: [...s.backStack, here].slice(-HISTORY_LIMIT),
      lastWorkbenchId: next.view === 'workbench' ? next.id : s.lastWorkbenchId,
    }));
    applyRoute(next);
  },

  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  setAddRepositoryOpen: (addRepositoryOpen) => set({ addRepositoryOpen }),

  reconcileWorkbenchRoute: ({ workbenches, listLoaded, offered }) => {
    const { route } = get();
    if (route.view !== 'workbench' && route.view !== 'history' && route.view !== 'split') return;
    if (offered === false) {
      get().navigate(HOME, { replace: true });
      return;
    }
    if (offered === null || route.view !== 'workbench' || !listLoaded) return;
    if (!workbenches[route.id]) {
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
