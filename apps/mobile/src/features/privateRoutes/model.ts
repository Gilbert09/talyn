import type { PrivateConnector, PrivateConnectorStatus, PrivatePeer, PrivateRoute } from '@talyn/shared';

export const POLL_MS = 2_000;
export const POLLING_STATES = new Set<PrivateConnectorStatus>(['needs_login', 'connecting']);

export const STATUS_COPY: Record<PrivateConnectorStatus, { label: string; detail: string }> = {
  needs_login: { label: 'Sign-in needed', detail: 'Open Tailscale sign-in to connect this workspace.' },
  awaiting_approval: { label: 'Waiting for approval', detail: 'A tailnet administrator must approve the connector in Tailscale.' },
  connecting: { label: 'Connecting', detail: 'Talyn is waiting for the private connector to become ready.' },
  connected: { label: 'Connected', detail: 'New sandboxes can use the exact destinations listed below.' },
  unavailable: { label: 'Unavailable', detail: 'The private connector is unavailable. Refresh its state or disconnect it.' },
};

export const FOOTER = 'Added routes apply to new sandboxes. Removed routes revoke access immediately. Existing public internet access stays unchanged.';

export function routeProblem(host: string, port: string): string | null {
  if (!host.trim()) return 'Enter one hostname or IP address.';
  if (/[/\s*]/.test(host.trim()) || host.includes('://')) return 'Enter one exact hostname or IP address.';
  const parsed = Number(port);
  if (!port.trim() || !Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return 'Enter a port from 1 to 65535.';
  return null;
}

export const routeLabel = (route: PrivateRoute) => `${route.host}:${route.port}`;

export function isDuplicateRoute(routes: PrivateRoute[], route: PrivateRoute): boolean {
  return routes.some((item) => item.host.toLowerCase() === route.host.toLowerCase() && item.port === route.port);
}

export type AddRouteResult = { error: string } | { routes: PrivateRoute[] };

/** Check a typed destination and return the whole new route list, as web does. */
export function addRoute(routes: PrivateRoute[], host: string, port: string): AddRouteResult {
  const problem = routeProblem(host, port);
  if (problem) return { error: problem };
  const route = { host: host.trim(), port: Number(port) };
  if (isDuplicateRoute(routes, route)) return { error: 'That destination is already allowed.' };
  return { routes: [...routes, route] };
}

export function removeRoute(routes: PrivateRoute[], route: PrivateRoute): PrivateRoute[] {
  return routes.filter((item) => item !== route);
}

/** The values a user can use as the host, best first. */
export function peerHosts(peer: PrivatePeer): string[] {
  return [...new Set([peer.dnsName, ...peer.addresses].filter(Boolean))];
}

/** True when every word of the query occurs in the name, OS, an address or a subnet of the peer. */
export function peerMatches(peer: PrivatePeer, query: string): boolean {
  const haystack = [peer.name, peer.os, ...peerHosts(peer), ...peer.subnetRoutes].join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/** The connector after a routes update: the response may omit the status. */
export function mergeConnector(current: PrivateConnector | null, updated: PrivateConnector): PrivateConnector {
  return current ? { ...current, ...updated, status: updated.status ?? current.status } : updated;
}

export const isPolling = (connector: PrivateConnector | null) => Boolean(connector?.status && POLLING_STATES.has(connector.status));
