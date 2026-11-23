import type { ActivePanel } from './panels';
import { isRoute, panelForRoute, type Route } from '../stores/navigation';

export const PANEL_PATHS = {
  queue: '/queue',
  my_prs: '/prs',
  reviews: '/reviews',
  merge_queue: '/merge-queue',
  integrations: '/integrations',
  code_reviews: '/code-reviews',
  workbenches: '/',
  mcp_servers: '/mcp-servers',
  settings: '/settings',
} as const satisfies Record<ActivePanel, string>;

/** Split view is a page of several sessions; its panes are kept on the device, not in the URL. */
export const SPLIT_PATH = '/split';

/** Insights is a page, not a panel: it has no `activePanel` of its own. */
export const INSIGHTS_PATH = '/insights';

export const PATH_TO_PANEL: Record<string, ActivePanel> = Object.fromEntries(
  Object.entries(PANEL_PATHS).map(([panel, path]) => [path, panel as ActivePanel])
);

export function pathForRoute(route: Route): string {
  switch (route.view) {
    case 'home':
      return '/';
    case 'workbench':
      return `/s/${encodeURIComponent(route.id)}`;
    case 'history':
      return '/history';
    case 'split':
      return SPLIT_PATH;
    case 'prs':
      return PANEL_PATHS[route.tab];
    case 'integrations':
      return route.kind ? `${PANEL_PATHS.integrations}/${route.kind}` : PANEL_PATHS.integrations;
    case 'settings':
      return `/settings/${route.section}`;
    case 'mcp_servers':
      return PANEL_PATHS.mcp_servers;
    case 'insights':
      return INSIGHTS_PATH;
  }
}

/** URLs from before the Integrations area. They resolve to a route, then the address is rewritten. */
export function isLegacyPath(pathname: string): boolean {
  return /^\/(workflows|loops)(\/.*)?$/.test(pathname.replace(/\/+$/, '') || '/');
}

/**
 * `routeForPath`, plus the query string, for a Slack callback that still
 * lands on `/settings?slack=...` while an install is in flight.
 */
export function routeForLocation(pathname: string, search: string): Route | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if ((path === '/settings' || path === '/settings/slack') && new URLSearchParams(search).has('slack')) {
    return { view: 'integrations', kind: 'slack' };
  }
  return routeForPath(pathname);
}

export function routeForPath(pathname: string): Route | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/workbenches') return { view: 'home' };
  if (/^\/workflows(\/.*)?$/.test(path)) return { view: 'integrations', kind: 'github' };
  if (/^\/loops(\/.*)?$/.test(path)) return { view: 'integrations', kind: 'schedule' };
  const integration = /^\/integrations\/([^/]+)$/.exec(path);
  if (integration) {
    const route = { view: 'integrations', kind: integration[1] };
    return isRoute(route) ? route : null;
  }
  if (path === '/history') return { view: 'history' };
  if (path === SPLIT_PATH) return { view: 'split' };
  if (path === '/settings') return { view: 'settings', section: 'workspace' };
  if (path === '/mcp-servers') return { view: 'mcp_servers' };
  if (path === INSIGHTS_PATH) return { view: 'insights' };
  const session = /^\/s\/([^/]+)$/.exec(path);
  if (session) {
    try {
      const id = decodeURIComponent(session[1]);
      return id ? { view: 'workbench', id } : null;
    } catch {
      return null;
    }
  }
  const settings = /^\/settings\/([^/]+)$/.exec(path);
  if (settings) {
    const route = { view: 'settings', section: settings[1] };
    return isRoute(route) ? route : null;
  }
  const panel = PATH_TO_PANEL[path];
  if (panel === 'integrations') return { view: 'integrations' };
  if (
    panel === 'my_prs' ||
    panel === 'reviews' ||
    panel === 'merge_queue' ||
    panel === 'code_reviews' ||
    panel === 'queue'
  ) {
    return { view: 'prs', tab: panel };
  }
  return null;
}

export function panelForPath(pathname: string): ActivePanel | null {
  const route = routeForPath(pathname);
  return route ? panelForRoute(route) : null;
}
