import { useEffect } from 'react';
import type { SpacePresenceEvent, TaskStatus, WorkbenchWsPayloads } from '@talyn/shared';
import { wsClient } from '../lib/api';
import { spacesOffered } from '../lib/spaces';
import { useOnReconnect } from './useOnReconnect';
import { useNavigationStore } from '../stores/navigation';
import { useWorkspaceStore } from '../stores/workspace';
import {
  findSpace,
  loadSpaceRepositories,
  loadSpaceSessions,
  loadSpaceTasks,
  loadTeams,
  useSpacesStore,
} from '../stores/spaces';

export const PRESENCE_HEARTBEAT_MS = 20_000;

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

export interface PresenceClient {
  subscribeSpace(spaceId: string): void;
  unsubscribeSpace(spaceId: string): void;
  sendPresence(spaceId: string, sessionId: string | null, state: 'active' | 'away'): void;
}

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
