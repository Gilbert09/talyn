import { isIP } from 'node:net';
import type { PrivateConnector, PrivatePeer, PrivateRoute } from '@talyn/shared';
import { workspaceHasFeature } from '../featureFlags.js';
import {
  FleetCapacityError,
  FleetClient,
  FleetHttpError,
  FleetThrottleError,
  type FleetSandboxPolicy,
} from './client.js';
import { fleetGatewayToken, fleetPinnedEndpoint } from './credentials.js';

const MAX_PRIVATE_ROUTES = 128;
const MAX_PRIVATE_PEERS = 1_000;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class PrivateRoutesServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PrivateRoutesServiceError';
  }
}

function client(): FleetClient {
  const endpoint = fleetPinnedEndpoint();
  const token = fleetGatewayToken();
  if (!endpoint || !token) {
    throw new PrivateRoutesServiceError(
      'Private routes are unavailable on this deployment.',
      503,
      'private_routes_unavailable',
    );
  }
  return new FleetClient(endpoint, token);
}

/** Whether this workspace owner is in the private-routes audience. */
export async function workspaceMayUsePrivateRoutes(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('privateRoutes', workspaceId)).enabled;
}

export async function startPrivateConnector(workspaceId: string): Promise<PrivateConnector> {
  try {
    return await client().startPrivateConnector(workspaceId);
  } catch (error) {
    throw mapPrivateRoutesError(error);
  }
}

export async function getPrivateConnector(workspaceId: string): Promise<PrivateConnector> {
  try {
    return await client().getPrivateConnector(workspaceId);
  } catch (error) {
    throw mapPrivateRoutesError(error);
  }
}

export async function listPrivatePeers(workspaceId: string): Promise<PrivatePeer[]> {
  try {
    return normalizePrivatePeers((await client().listPrivatePeers(workspaceId))?.peers);
  } catch (error) {
    throw mapPrivateRoutesError(error);
  }
}

/** Keep only well-formed peers so a YAS change cannot break the settings page. */
export function normalizePrivatePeers(value: unknown): PrivatePeer[] {
  if (!Array.isArray(value)) return [];
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  const peers: PrivatePeer[] = [];
  for (const entry of value.slice(0, MAX_PRIVATE_PEERS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const dnsName = typeof record.dnsName === 'string' ? record.dnsName.replace(/\.$/, '') : '';
    const addresses = strings(record.addresses);
    const name = typeof record.name === 'string' && record.name
      ? record.name
      : dnsName.split('.')[0] || addresses[0] || '';
    if (!name || (!dnsName && addresses.length === 0)) continue;
    peers.push({
      name,
      dnsName,
      addresses,
      os: typeof record.os === 'string' ? record.os : '',
      online: record.online === true,
      subnetRoutes: strings(record.subnetRoutes),
    });
  }
  return peers;
}

export async function replacePrivateRoutes(
  workspaceId: string,
  routes: PrivateRoute[],
): Promise<PrivateConnector> {
  try {
    return await client().replacePrivateRoutes(workspaceId, routes);
  } catch (error) {
    throw mapPrivateRoutesError(error);
  }
}

export async function deletePrivateConnector(workspaceId: string): Promise<void> {
  try {
    await client().deletePrivateConnector(workspaceId);
  } catch (error) {
    throw mapPrivateRoutesError(error);
  }
}

/** Validate and canonicalize the complete allow-list before it reaches YAS. */
export function validatePrivateRoutes(value: unknown): PrivateRoute[] {
  if (!Array.isArray(value)) {
    throw new PrivateRoutesServiceError('routes must be an array', 400, 'bad_request');
  }
  if (value.length > MAX_PRIVATE_ROUTES) {
    throw new PrivateRoutesServiceError(
      `routes cannot contain more than ${MAX_PRIVATE_ROUTES} destinations`,
      400,
      'bad_request',
    );
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PrivateRoutesServiceError(`routes[${index}] must be an object`, 400, 'bad_request');
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => key !== 'host' && key !== 'port');
    if (unknown.length > 0) {
      throw new PrivateRoutesServiceError(
        `routes[${index}] has unknown field ${unknown[0]}`,
        400,
        'bad_request',
      );
    }
    if (typeof record.host !== 'string') {
      throw new PrivateRoutesServiceError(`routes[${index}].host must be a string`, 400, 'bad_request');
    }
    const host = record.host.trim().toLowerCase().replace(/\.$/, '');
    if (!validHost(host)) {
      throw new PrivateRoutesServiceError(
        `routes[${index}].host must be one exact hostname or IP address`,
        400,
        'bad_request',
      );
    }
    if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65_535) {
      throw new PrivateRoutesServiceError(
        `routes[${index}].port must be a whole number from 1 to 65535`,
        400,
        'bad_request',
      );
    }
    const port = record.port as number;
    const key = `${host}\u0000${port}`;
    if (seen.has(key)) {
      throw new PrivateRoutesServiceError(`routes contains duplicate destination ${host}:${port}`, 400, 'bad_request');
    }
    seen.add(key);
    return { host, port };
  });
}

function validHost(host: string): boolean {
  if (!host || host.length > 253 || host.includes('/') || host.includes('*') || host.includes('://')) return false;
  if (isIP(host) !== 0) return true;
  const labels = host.split('.');
  return labels.length > 0 && labels.every((label) => HOST_LABEL.test(label));
}

/** Add connected private routes while preserving credentials and public egress. */
export function composePrivateRoutesPolicy(
  policy: FleetSandboxPolicy,
  connector: PrivateConnector | null,
): FleetSandboxPolicy {
  if (connector?.status !== 'connected' || connector.routes.length === 0) return policy;
  return {
    ...policy,
    version: 2,
    privateRoutes: connector.routes.map((route) => ({ connectorId: connector.id, ...route })),
  };
}

/** The one policy path used by tasks, sessions, moves, and warm boxes. */
export async function sandboxPolicyForWorkspace(
  workspaceId: string,
  policy: FleetSandboxPolicy,
): Promise<FleetSandboxPolicy> {
  if (!(await workspaceMayUsePrivateRoutes(workspaceId))) return policy;
  try {
    return composePrivateRoutesPolicy(policy, await getPrivateConnector(workspaceId));
  } catch (error) {
    const mapped = mapPrivateRoutesError(error);
    if (mapped.status !== 404) {
      console.warn('[private-routes] sandbox policy omitted because connector state is unavailable', {
        workspaceId,
        status: mapped.status,
        code: mapped.code,
      });
    }
    return policy;
  }
}

export function mapPrivateRoutesError(error: unknown): PrivateRoutesServiceError {
  if (error instanceof PrivateRoutesServiceError) return error;
  if (error instanceof FleetHttpError) {
    const message = error.status === 404
      ? 'This workspace has no private connector.'
      : error.status === 409 && error.code === 'connector_not_connected'
        ? 'The private connector is not connected.'
        : error.status === 409
          ? 'The private connector cannot make that change in its current state.'
          : error.status >= 400 && error.status < 500
            ? 'The private-routes request was rejected.'
            : 'Private routes are temporarily unavailable.';
    return new PrivateRoutesServiceError(
      message,
      error.status,
      error.code ?? 'private_routes_request_failed',
    );
  }
  if (error instanceof FleetThrottleError) {
    return new PrivateRoutesServiceError('Private routes are rate limited. Try again shortly.', 429, 'rate_limited');
  }
  if (error instanceof FleetCapacityError) {
    if (error.code === 'login_pending') {
      return new PrivateRoutesServiceError('Tailscale login is still starting. Try again shortly.', 503, 'login_pending');
    }
    return new PrivateRoutesServiceError(
      'Private routes are temporarily unavailable.',
      503,
      error.code ?? 'private_routes_unavailable',
    );
  }
  return new PrivateRoutesServiceError(
    'Private routes are temporarily unavailable.',
    503,
    'private_routes_unavailable',
  );
}
