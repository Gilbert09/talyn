import { create } from 'zustand';
import type { Workbench } from '@talyn/shared';
import { setPanelNavigator, useWorkspaceStore, type ActivePanel, type SettingsSection } from './workspace';
import { useWorkbenchStore } from './workbenches';

/**
 * Where the app is: one route, a short back/forward history, and the last
 * route persisted across launches.
 *
 * The route is the source of truth for what the main column shows.
 * `useWorkspaceStore.activePanel` is DERIVED from it (written here on every
 * change), and `setActivePanel` / `openSettings` are adapters that call
 * `navigate`, so the older callers keep their panel vocabulary.
 *
 * Workbench selection follows the route, in one direction: `navigate` to a
 * workbench writes `useWorkbenchStore.selectedWorkbenchId`, and leaving the
 * workbench route clears it (so a chat that finishes while you are elsewhere
 * is marked unread). Code that still calls `selectWorkbench(id)` directly is
 * forwarded into `navigate` by one subscription at the bottom of this file,
 * so the mirror can never disagree with the route.
 */

export type PrTab = 'my_prs' | 'reviews' | 'code_reviews' | 'merge_queue' | 'queue';
export type AutomationTab = 'workflows' | 'loops' | 'mcp_servers';

export type Route =
  | { view: 'home' }
  | { view: 'workbench'; id: string }
  | { view: 'history' }
  | { view: 'prs'; tab: PrTab }
  | { view: 'automations'; tab: AutomationTab }
  | { view: 'settings'; section: SettingsSection };

export const PR_TABS: readonly PrTab[] = ['my_prs', 'reviews', 'code_reviews', 'merge_queue', 'queue'];
export const AUTOMATION_TABS: readonly AutomationTab[] = ['workflows', 'loops', 'mcp_servers'];
const SETTINGS_SECTIONS: readonly SettingsSection[] = [
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
export const ROUTE_STORAGE_KEY = 'talyn-last-route';
/** Enough to walk back through a session's recent places; more is just memory. */
export const HISTORY_LIMIT = 50;

export function isRoute(value: unknown): value is Route {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  switch (r.view) {
    case 'home':
    case 'history':
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

export function readPersistedRoute(): Route {
  try {
    const raw = localStorage.getItem(ROUTE_STORAGE_KEY);
    if (!raw) return HOME;
    const parsed: unknown = JSON.parse(raw);
    return isRoute(parsed) ? parsed : HOME;
  } catch {
    return HOME;
  }
}

function persistRoute(route: Route): void {
  try {
    localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify(route));
  } catch {
    // ignore quota / privacy-mode issues
  }
}

export function routesEqual(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The panel name the older code reads. Home, workbenches and History all count as 'workbenches'. */
export function panelForRoute(route: Route): ActivePanel {
  switch (route.view) {
    case 'prs':
    case 'automations':
      return route.tab;
    case 'settings':
      return 'settings';
    default:
      return 'workbenches';
  }
}

/** The analytics `panel` value: the old panel names where they still apply, the view name otherwise. */
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

/** The route `setActivePanel(panel)` means. 'workbenches' reopens the last workbench, else home. */
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
    case 'mcp_servers':
      return { view: 'automations', tab: panel };
    case 'settings':
      return { view: 'settings', section: ctx.settingsSection };
    case 'workbenches':
    default: {
      const id = ctx.lastWorkbenchId;
      return id && isLive(ctx.workbenches[id]) ? { view: 'workbench', id } : HOME;
    }
  }
}

interface NavigationState {
  route: Route;
  backStack: Route[];
  forwardStack: Route[];
  /** The workbench open most recently, for "back to workbenches". */
  lastWorkbenchId: string | null;
  paletteOpen: boolean;
  addRepositoryOpen: boolean;

  navigate: (route: Route, opts?: { replace?: boolean }) => void;
  back: () => void;
  forward: () => void;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  setAddRepositoryOpen: (open: boolean) => void;
  /**
   * Leave a workbench route that no longer points at a live workbench (a
   * persisted id deleted elsewhere, an archive, a workspace switch), and
   * select the workbench once the list has it. The shell calls it whenever
   * the list or the route changes.
   */
  reconcileWorkbenchRoute: (input: {
    workbenches: Record<string, Workbench>;
    listLoaded: boolean;
    /** False once features have loaded and workbenches are not offered. */
    offered: boolean | null;
  }) => void;
}

/** Side effects of arriving at a route: the derived panel, the settings section, the workbench selection. */
function applyRoute(route: Route): void {
  persistRoute(route);
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

const initialRoute = readPersistedRoute();

export const useNavigationStore = create<NavigationState>((set, get) => ({
  route: initialRoute,
  backStack: [],
  forwardStack: [],
  lastWorkbenchId: initialRoute.view === 'workbench' ? initialRoute.id : null,
  paletteOpen: false,
  addRepositoryOpen: false,

  navigate: (route, opts) => {
    const cur = get().route;
    const lastWorkbenchId = route.view === 'workbench' ? route.id : get().lastWorkbenchId;
    if (routesEqual(cur, route)) {
      set({ lastWorkbenchId });
    } else if (opts?.replace) {
      set({ route, lastWorkbenchId });
    } else {
      set((s) => ({
        route,
        lastWorkbenchId,
        backStack: [...s.backStack, cur].slice(-HISTORY_LIMIT),
        forwardStack: [],
      }));
    }
    applyRoute(route);
  },

  back: () => {
    const { backStack, route } = get();
    if (backStack.length === 0) return;
    const prev = backStack[backStack.length - 1];
    set((s) => ({
      route: prev,
      backStack: s.backStack.slice(0, -1),
      forwardStack: [route, ...s.forwardStack].slice(0, HISTORY_LIMIT),
      lastWorkbenchId: prev.view === 'workbench' ? prev.id : s.lastWorkbenchId,
    }));
    applyRoute(prev);
  },

  forward: () => {
    const { forwardStack, route } = get();
    if (forwardStack.length === 0) return;
    const next = forwardStack[0];
    set((s) => ({
      route: next,
      forwardStack: s.forwardStack.slice(1),
      backStack: [...s.backStack, route].slice(-HISTORY_LIMIT),
      lastWorkbenchId: next.view === 'workbench' ? next.id : s.lastWorkbenchId,
    }));
    applyRoute(next);
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
    if (route.view !== 'workbench' || !listLoaded) return;
    if (!isLive(workbenches[route.id])) {
      get().navigate(HOME, { replace: true });
      return;
    }
    if (useWorkbenchStore.getState().selectedWorkbenchId !== route.id) {
      useWorkbenchStore.getState().selectWorkbench(route.id);
    }
  },
}));

// The adapter behind setActivePanel / openSettings.
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

// Derive the panel for the persisted route before anything renders.
useWorkspaceStore.setState({
  activePanel: panelForRoute(initialRoute),
  ...(initialRoute.view === 'settings' ? { settingsSection: initialRoute.section } : {}),
});

// A direct selectWorkbench(id) is a request to open that workbench;
// selectWorkbench(null) while one is open (archive, workspace switch) goes home.
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

// Settings' own section list writes settingsSection; keep the route's copy in step without a history entry.
useWorkspaceStore.subscribe((s, prev) => {
  if (s.settingsSection === prev.settingsSection) return;
  const { route } = useNavigationStore.getState();
  if (route.view === 'settings' && route.section !== s.settingsSection) {
    const next: Route = { view: 'settings', section: s.settingsSection };
    useNavigationStore.setState({ route: next });
    persistRoute(next);
  }
});
