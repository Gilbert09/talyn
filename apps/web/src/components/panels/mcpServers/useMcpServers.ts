import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  mcpServerToInput,
  type McpProbeResult,
  type McpServerDefinition,
  type McpServerInput,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useOnReconnect } from '../../../hooks/useOnReconnect';

/**
 * The Tool servers page's data.
 *
 * Owned here rather than in a global store, for the reason `useLoops` is: this
 * is the only screen that reads a tool server. Only the badge count is lifted
 * into the store.
 *
 * There is no live WS subscription, deliberately. A tool server changes when a
 * person edits it, so there is nothing arriving on its own to catch up with —
 * the reconnect handler is still here because a socket drop usually means the
 * page has been asleep, and a stale list after that is the common case.
 */
export interface UseMcpServers {
  /** `null` while loading — never conflated with "none", which renders differently. */
  servers: McpServerDefinition[] | null;
  error: string | null;
  reload: () => void;
  create: (input: McpServerInput) => Promise<McpServerDefinition>;
  update: (id: string, input: McpServerInput) => Promise<McpServerDefinition>;
  remove: (id: string) => Promise<void>;
  setEnabled: (server: McpServerDefinition, enabled: boolean) => Promise<void>;
  /** Probe a server and keep the answer. Returns it so a form can react. */
  test: (id: string) => Promise<McpProbeResult>;
  /** Which server is being probed right now, so a row can show it. */
  testing: string | null;
}

export function useMcpServers(): UseMcpServers {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [servers, setServers] = useState<McpServerDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  // Guards a response from a workspace the user has already switched away from.
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const load = useCallback(() => {
    if (!workspaceId) {
      setServers(null);
      return;
    }
    api.mcpServers
      .list(workspaceId)
      .then((rows) => {
        if (workspaceRef.current !== workspaceId) return;
        setServers(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (workspaceRef.current !== workspaceId) return;
        setServers([]);
        setError(err instanceof Error ? err.message : 'Could not load tool servers');
      });
  }, [workspaceId]);

  useEffect(() => {
    setServers(null);
    load();
  }, [load]);

  useOnReconnect(load);

  const create = useCallback(
    async (input: McpServerInput) => {
      if (!workspaceId) throw new Error('no workspace');
      const made = await api.mcpServers.create(workspaceId, input);
      setServers((prev) => [...(prev ?? []), made].sort((a, b) => a.name.localeCompare(b.name)));
      return made;
    },
    [workspaceId]
  );

  const update = useCallback(async (id: string, input: McpServerInput) => {
    const next = await api.mcpServers.update(id, input);
    setServers((prev) => (prev ?? []).map((s) => (s.id === id ? next : s)));
    return next;
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.mcpServers.remove(id);
    setServers((prev) => (prev ?? []).filter((s) => s.id !== id));
  }, []);

  /**
   * The on/off switch. Sends the whole definition, because PATCH is a
   * whole-server replace — `authKind` and `inject` validate against each other.
   *
   * `mcpServerToInput` deliberately omits the credential, which is exactly
   * right here: omitting it keeps the stored one, so toggling a server off and
   * on again does not disconnect it.
   */
  const setEnabled = useCallback(
    async (server: McpServerDefinition, enabled: boolean) => {
      // Optimistic: a switch must feel like a switch. Rolled back by a reload.
      setServers((prev) => (prev ?? []).map((s) => (s.id === server.id ? { ...s, enabled } : s)));
      try {
        const next = await api.mcpServers.update(server.id, {
          ...mcpServerToInput(server),
          enabled,
        });
        setServers((prev) => (prev ?? []).map((s) => (s.id === next.id ? next : s)));
      } catch (err) {
        load();
        throw err;
      }
    },
    [load]
  );

  const test = useCallback(async (id: string) => {
    setTesting(id);
    try {
      const probe = await api.mcpServers.test(id);
      // Spliced in rather than re-listed: the server stores the probe too, so
      // the two agree, and a re-list would flicker the whole page for one row.
      setServers((prev) => (prev ?? []).map((s) => (s.id === id ? { ...s, lastProbe: probe } : s)));
      return probe;
    } finally {
      setTesting(null);
    }
  }, []);

  return useMemo(
    () => ({ servers, error, reload: load, create, update, remove, setEnabled, test, testing }),
    [servers, error, load, create, update, remove, setEnabled, test, testing]
  );
}
