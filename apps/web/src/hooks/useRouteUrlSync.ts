import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { HOME, routesEqual, useNavigationStore, type Route } from '../stores/navigation';
import { pathForRoute, routeForPath } from '../lib/routes';

// One effect resolves the side that changed. Separate effects can undo each other.
export function useRouteUrlSync(): void {
  const route = useNavigationStore((s) => s.route);
  const replace = useNavigationStore((s) => s.replace);
  const setRoute = useNavigationStore((s) => s.navigate);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const last = useRef<{ route: Route; path: string } | null>(null);

  useEffect(() => {
    if (last.current === null) {
      const fromUrl = routeForPath(pathname) ?? HOME;
      const path = routeForPath(pathname) ? pathname : pathForRoute(fromUrl);
      last.current = { route: fromUrl, path };
      setRoute(fromUrl, { replace: true });
      if (path !== pathname) navigate(path, { replace: true });
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
      setRoute(fromUrl, { replace: true });
      if (path !== pathname) navigate(path, { replace: true });
    }
  }, [route, replace, pathname, navigate, setRoute]);
}
