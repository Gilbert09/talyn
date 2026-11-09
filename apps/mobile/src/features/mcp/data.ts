import { mcpServers, workspaces } from '@talyn/client/native';
import type { McpServerDefinition, PrivateRoute } from '@talyn/shared';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { appReturnBase } from '../../lib/returnTo';
import { useRemote } from '../more/useRemote';
import { isInvalidReturnTo } from './model';

const listeners = new Set<() => void>();
let version = 0;

/** Tell open MCP screens that a server changed, so the list reads again. */
export function notifyMcpChanged() {
  version += 1;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const snapshot = () => version;

/** The workspace's MCP servers. It reads again after an editor saves, removes or connects one. */
export function useMcpServerList(workspaceId: string | null) {
  const remote = useRemote<McpServerDefinition[]>(workspaceId ? `mcp-servers:${workspaceId}` : null,
    () => mcpServers.list(workspaceId ?? ''));
  const changed = useSyncExternalStore(subscribe, snapshot, snapshot);
  const seen = useRef(changed);
  const { refresh } = remote;
  useEffect(() => {
    if (seen.current === changed) return;
    seen.current = changed;
    void refresh();
  }, [changed, refresh]);
  return remote;
}

/** The workspace's private routes, which let the validator accept a private host. None when the read fails. */
export function usePrivateRoutes(workspaceId: string | null): PrivateRoute[] {
  const remote = useRemote<PrivateRoute[]>(workspaceId ? `mcp-private-routes:${workspaceId}` : null,
    async () => (await workspaces.privateConnector.get(workspaceId ?? '')).routes ?? []);
  const { data } = remote;
  return useMemo(() => data ?? [], [data]);
}

/**
 * Starts the sign-in with the app's return link. An older backend refuses
 * `returnTo` with 400 `invalid_return_to`; then the flow starts without it
 * and the poll finds the result.
 */
export async function startSignInWithReturn(id: string) {
  try {
    return await mcpServers.startSignIn(id, { returnTo: appReturnBase() });
  } catch (error) {
    if (isInvalidReturnTo(error)) return mcpServers.startSignIn(id);
    throw error;
  }
}
