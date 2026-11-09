import { spaces, teams, wsClient } from '@talyn/client/native';
import type { SpaceItemsResponse, SpacePresenceEvent, SpacePresenceMember, SpaceSessionRow, SpacesTeam, SpaceTaskRow, TeamMember } from '@talyn/shared';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useAuth, useMobileRuntime } from '../../auth/AuthProvider';
import { useFeatures } from '../../lib/features';
import { MIN_REFRESH_MS, useRemote } from '../more/useRemote';
import { spacesOffered } from './model';

/** How often an open space says "I am still here". The server forgets a viewer 60 s after the last one. */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/** My teams and their spaces, when Spaces is offered. Null data until the first answer. */
export function useTeams() {
  const offered = spacesOffered(useFeatures());
  const user = useAuth().user?.id ?? null;
  return useRemote<SpacesTeam[]>(offered && user ? `teams:${user}` : null, () => teams.list(), { intervalMs: 120_000 });
}

export function useTeamMembers(teamId: string | null) {
  return useRemote<TeamMember[]>(teamId ? `team-members:${teamId}` : null, () => teams.members(teamId ?? ''), { intervalMs: 120_000 });
}

export interface SpaceItems { sessions: SpaceItemsResponse<SpaceSessionRow>; tasks: SpaceItemsResponse<SpaceTaskRow> }

export function useSpaceItems(spaceId: string | null) {
  return useRemote<SpaceItems>(spaceId ? `space-items:${spaceId}` : null, async () => {
    const [sessionList, taskList] = await Promise.all([spaces.sessions(spaceId ?? ''), spaces.tasks(spaceId ?? '')]);
    return { sessions: sessionList, tasks: taskList };
  });
}

/**
 * While a space is open: subscribe to it, say I am here (with no session
 * open) every 20 seconds, say `away` while the app is in the background, and
 * unsubscribe on leaving. Answers who the space's presence lists. Mirrors web
 * `usePresenceHeartbeat` and the `space:presence` handler.
 */
export function useSpacePresence(spaceId: string | null): SpacePresenceMember[] | undefined {
  const { lifecycle } = useMobileRuntime();
  const activity = useSyncExternalStore(lifecycle.subscribe, () => lifecycle.getSnapshot().activity, () => lifecycle.getSnapshot().activity);
  const [presence, setPresence] = useState<{ spaceId: string; members: SpacePresenceMember[] } | null>(null);

  useEffect(() => {
    if (!spaceId) return undefined;
    wsClient.subscribeSpace(spaceId);
    const off = wsClient.on<SpacePresenceEvent['payload']>('space:presence', (payload) => {
      if (payload?.spaceId === spaceId) setPresence({ spaceId, members: payload.members ?? [] });
    });
    return () => { off(); wsClient.unsubscribeSpace(spaceId); };
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId) return undefined;
    const here = activity === 'active';
    const beat = () => wsClient.sendPresence(spaceId, null, here ? 'active' : 'away');
    beat();
    if (!here) return undefined;
    const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [spaceId, activity]);

  return presence?.spaceId === spaceId ? presence.members : undefined;
}

/**
 * Refresh a space's lists when a socket event names one of its sessions or
 * tasks, at most once every 30 seconds, so a busy space does not refetch on
 * every frame. Pull to refresh is always immediate.
 */
export function useSpaceEvents(ids: ReadonlySet<string>, spaceId: string | null, refresh: () => void) {
  const latest = useRef({ ids, refresh });
  latest.current = { ids, refresh };
  useEffect(() => {
    if (!spaceId) return undefined;
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (pending) return;
      const wait = Math.max(0, last + MIN_REFRESH_MS - Date.now());
      pending = setTimeout(() => { pending = null; last = Date.now(); latest.current.refresh(); }, wait);
    };
    const matches = (id: unknown, space?: unknown) => (typeof id === 'string' && latest.current.ids.has(id)) || space === spaceId;
    const offs = [
      wsClient.on<{ workbench?: { id?: string; spaceId?: string | null } }>('workbench:updated', (payload) => {
        if (matches(payload?.workbench?.id, payload?.workbench?.spaceId)) nudge();
      }),
      wsClient.on<{ chat?: { workbenchId?: string } }>('workbench:chat', (payload) => { if (matches(payload?.chat?.workbenchId)) nudge(); }),
      wsClient.on<{ id?: string }>('workbench:deleted', (payload) => { if (matches(payload?.id)) nudge(); }),
      wsClient.on<{ taskId?: string }>('task:status', (payload) => { if (matches(payload?.taskId)) nudge(); }),
    ];
    return () => { offs.forEach((off) => off()); if (pending) clearTimeout(pending); };
  }, [spaceId]);
}
