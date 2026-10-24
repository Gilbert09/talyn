import type { ActivePanel } from './panels';
import { isRoute, panelForRoute, type Route } from '../stores/navigation';

export const PANEL_PATHS = {
  queue: '/queue',
  my_prs: '/prs',
  reviews: '/reviews',
  merge_queue: '/merge-queue',
  workflows: '/workflows',
  loops: '/loops',
  code_reviews: '/code-reviews',
  workbenches: '/',
  mcp_servers: '/mcp-servers',
  settings: '/settings',
} as const satisfies Record<ActivePanel, string>;

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
    case 'prs':
    case 'automations':
      return PANEL_PATHS[route.tab];
    case 'settings':
      return `/settings/${route.section}`;
    case 'mcp_servers':
      return PANEL_PATHS.mcp_servers;
  }
}

export function routeForPath(pathname: string): Route | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/workbenches') return { view: 'home' };
  if (path === '/history') return { view: 'history' };
  if (path === '/settings') return { view: 'settings', section: 'workspace' };
  if (path === '/mcp-servers') return { view: 'mcp_servers' };
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
  if (panel === 'workflows' || panel === 'loops') return { view: 'automations', tab: panel };
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
