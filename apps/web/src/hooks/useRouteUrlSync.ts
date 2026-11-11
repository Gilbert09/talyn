import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { HOME, routesEqual, useNavigationStore, type Route } from '../stores/navigation';
import { isLegacyPath, pathForRoute, routeForLocation, routeForPath } from '../lib/routes';

// One effect resolves the side that changed. Separate effects can undo each other.
export function useRouteUrlSync(): void {
  const route = useNavigationStore((s) => s.route);
  const replace = useNavigationStore((s) => s.replace);
  const setRoute = useNavigationStore((s) => s.navigate);
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const last = useRef<{ route: Route; path: string } | null>(null);

  useEffect(() => {
    if (last.current === null) {
      const fromUrl = routeForLocation(pathname, search) ?? HOME;
      // An old address (/workflows, /loops, /settings?slack=...) is rewritten to its new page; the query string stays.
      const moved = isLegacyPath(pathname) || (fromUrl.view === 'integrations' && !pathname.startsWith('/integrations'));
      const path = routeForPath(pathname) && !moved ? pathname : pathForRoute(fromUrl);
      last.current = { route: fromUrl, path };
      setRoute(fromUrl, { replace: true });
      if (path !== pathname) navigate({ pathname: path, search: moved ? search : '' }, { replace: true });
      return;
    }

    if (!routesEqual(route, last.current.route)) {
      const path = pathForRoute(route);
      last.current = { route, path };
      if (path !== pathname) navigate(path, { replace });
      return;
    }

    if (pathname !== last.current.path) {
      const fromUrl = routeForPath(pathname) ?? HOME;
      const path = routeForPath(pathname) ? pathname : pathForRoute(fromUrl);
      last.current = { route: fromUrl, path };
      // The browser's back and forward buttons walk the app history, so the context returns too.
      const nav = useNavigationStore.getState();
      const prev = nav.backStack[nav.backStack.length - 1];
      if (prev && routesEqual(prev.route, fromUrl)) nav.back();
      else if (nav.forwardStack[0] && routesEqual(nav.forwardStack[0].route, fromUrl)) nav.forward();
      else setRoute(fromUrl, { replace: true });
      if (path !== pathname) navigate(path, { replace: true });
    }
  }, [route, replace, pathname, search, navigate, setRoute]);
}
