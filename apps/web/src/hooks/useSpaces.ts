import { useEffect, useRef } from 'react';
import type { SpacePresenceEvent, TaskStatus, WorkbenchWsPayloads } from '@talyn/shared';
import { wsClient } from '../lib/api';
import { followSessionContext, spacesOffered } from '../lib/spaces';
import { useOnReconnect } from './useOnReconnect';
import { useNavigationStore } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';
import {
  findSpace,
  loadSpaceRepositories,
  loadSpaceSessions,
  loadSpaceTasks,
  loadTeams,
  useSpacesStore,
} from '../stores/spaces';

/** How often an open space says "I am still here". The server forgets a viewer 60s after the last one. */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/**
 * Load my teams when Spaces is offered, and fall back to Personal when the
 * stored space is gone (archived, or I left the team).
 */
export function useSpacesBoot(): void {
  const offered = useWorkspaceStore((s) => spacesOffered(s.features));
  const context = useWorkspaceStore((s) => s.currentContext);
  const teams = useSpacesStore((s) => s.teams);

  useEffect(() => {
    if (offered) void loadTeams();
  }, [offered]);

  useOnReconnect(() => {
    if (spacesOffered(useWorkspaceStore.getState().features)) void loadTeams();
  });

  useEffect(() => {
    if (!offered || context.kind !== 'space' || teams === null) return;
    if (!findSpace(teams, context.spaceId)) useWorkspaceStore.getState().setContext({ kind: 'personal', workspaceId: null });
  }, [offered, context, teams]);
}

/**
 * When a session from another space or workspace opens, for example from a
 * link, move the app there. This occurs one time for each opened session, so
 * a later context switch on the same session is not undone.
 */
export function useFollowSessionContext(): void {
  const routeId = useNavigationStore((s) => (s.route.view === 'workbench' ? s.route.id : null));
  const workbench = useWorkbenchStore((s) => (routeId ? s.workbenches[routeId] : undefined));
  const features = useWorkspaceStore((s) => s.features);
  const teams = useSpacesStore((s) => s.teams);
  const followed = useRef<string | null>(null);

  useEffect(() => {
    if (!routeId) {
      followed.current = null;
      return;
    }
    if (followed.current === routeId || !workbench) return;
    if (followSessionContext(workbench)) followed.current = routeId;
  }, [routeId, workbench, features, teams]);
}

/** The socket calls the presence hook makes. A seam for tests. */
export interface PresenceClient {
  subscribeSpace(spaceId: string): void;
  unsubscribeSpace(spaceId: string): void;
  sendPresence(spaceId: string, sessionId: string | null, state: 'active' | 'away'): void;
}

/**
 * While a space is open: subscribe to it, say which session I have open on
 * each navigation and every 20s, say `away` while the tab is hidden, and
 * unsubscribe on leaving.
 */
export function usePresenceHeartbeat(
  spaceId: string | null,
  sessionId: string | null,
  client: PresenceClient = wsClient,
): void {
  useEffect(() => {
    if (!spaceId) return undefined;
    client.subscribeSpace(spaceId);
    return () => client.unsubscribeSpace(spaceId);
  }, [spaceId, client]);

  useEffect(() => {
    if (!spaceId) return undefined;
    const beat = () => {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      client.sendPresence(spaceId, hidden ? null : sessionId, hidden ? 'away' : 'active');
    };
    beat();
    const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [spaceId, sessionId, client]);
}

/** Keep the open space's lists, presence and repositories live without polling. */
export function useSpaceLive(spaceId: string | null): void {
  const route = useNavigationStore((s) => s.route);
  usePresenceHeartbeat(spaceId, route.view === 'workbench' ? route.id : null);

  useEffect(() => {
    if (!spaceId) return;
    void loadSpaceSessions(spaceId);
    void loadSpaceTasks(spaceId);
    void loadSpaceRepositories(spaceId);
  }, [spaceId]);

  useOnReconnect(() => {
    if (!spaceId) return;
    void loadSpaceSessions(spaceId);
    void loadSpaceTasks(spaceId);
  });

  useEffect(() => {
    if (!spaceId) return undefined;
    const store = () => useSpacesStore.getState();
    const offs = [
      wsClient.on<SpacePresenceEvent['payload']>('space:presence', (payload) => {
        store().setPresence(payload.spaceId, payload.members);
      }),
      wsClient.on<WorkbenchWsPayloads['workbench:updated']>('workbench:updated', (payload) => {
        if (store().applyWorkbench(payload.workbench)) void loadSpaceSessions(spaceId);
      }),
      wsClient.on<WorkbenchWsPayloads['workbench:deleted']>('workbench:deleted', (payload) => {
        store().removeSession(payload.id);
      }),
      wsClient.on<WorkbenchWsPayloads['workbench:chat']>('workbench:chat', (payload) => {
        store().applyChat(payload.chat);
      }),
      wsClient.on<{ taskId: string; status: TaskStatus }>('task:status', (payload) => {
        store().applyTaskStatus(payload.taskId, payload.status);
      }),
      wsClient.on<{ taskId: string; updates: Record<string, unknown> }>('task:update', (payload) => {
        if (store().applyTaskUpdate(payload.taskId, payload.updates ?? {})) void loadSpaceTasks(spaceId);
      }),
      wsClient.on<{ taskId: string }>('task:deleted', (payload) => {
        store().removeTask(payload.taskId);
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [spaceId]);
}
