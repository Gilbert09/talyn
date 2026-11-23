import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import {
  sessionAttentionKey,
  type ContextAttentionCounts,
  type ContextAttentionReason,
  type SpacesTeam,
  type Workbench,
  type WorkbenchChat,
  type Workspace,
  type WorkspaceLogo,
} from '@talyn/shared';
import { api } from './api';
import { useWorkspaceStore, type AppContext } from '../stores/workspace';
import { toast } from '../stores/toast';

/**
 * The context rail: the bar on the far left that switches between my
 * workspaces and my teams' spaces, like Slack's workspace bar. It shows only
 * when there are two or more contexts. Its order is the switcher's order, so
 * ⌘⇧1–9 counts the same tiles.
 */

export type RailEntry =
  | { kind: 'workspace'; id: string; name: string; logo?: WorkspaceLogo; context: AppContext; groupStart: boolean }
  | {
      kind: 'space';
      id: string;
      name: string;
      teamName: string;
      color: string | null;
      image: string | null;
      context: AppContext;
      groupStart: boolean;
    };

export function railEntries(workspaces: Workspace[], teams: SpacesTeam[] | null, spacesOn: boolean): RailEntry[] {
  const out: RailEntry[] = workspaces.map((w) => ({
    kind: 'workspace',
    id: w.id,
    name: w.name,
    logo: w.logo,
    context: { kind: 'personal', workspaceId: w.id },
    groupStart: false,
  }));
  if (!spacesOn) return out;
  for (const team of teams ?? []) {
    team.spaces.forEach((s, i) => {
      out.push({
        kind: 'space',
        id: s.id,
        name: s.name,
        teamName: team.name,
        color: s.color,
        image: s.image ?? null,
        context: { kind: 'space', spaceId: s.id },
        // A line before each team's spaces, so the teams read apart.
        groupStart: i === 0,
      });
    });
  }
  return out;
}

/**
 * The count on a tile. A space tile counts its sessions. A workspace tile
 * counts the sessions of its Personal sidebar: a session in a space that has
 * its own tile is counted there, so the workspace tile leaves it out.
 */
export function railEntryAttention(entry: RailEntry, counts: ContextAttentionCounts | null, entries: readonly RailEntry[] = []): number {
  if (!counts) return 0;
  if (entry.kind === 'space') return counts.spaces[entry.id] ?? 0;
  const total = counts.workspaces[entry.id] ?? 0;
  const bySpace = counts.workspaceSpaces?.[entry.id];
  if (!bySpace) return total;
  const inTiles = entries.reduce((sum, e) => (e.kind === 'space' ? sum + (bySpace[e.id] ?? 0) : sum), 0);
  return Math.max(0, total - inTiles);
}

/** Up to two letters for a space tile: "Growth" -> "G", "Data Platform" -> "DP". */
export function railInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? [...words[0]].slice(0, 1) : [[...words[0]][0], [...words[1]][0]];
  return letters.join('').toUpperCase();
}

/**
 * My workspaces after a drag in the rail drops `fromId` on `toId`: the dragged
 * one takes the target's place. The same array when nothing moves.
 */
export function moveWorkspace(workspaces: Workspace[], fromId: string, toId: string): Workspace[] {
  const from = workspaces.findIndex((w) => w.id === fromId);
  const to = workspaces.findIndex((w) => w.id === toId);
  if (from < 0 || to < 0 || from === to) return workspaces;
  const next = [...workspaces];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Move a workspace in the rail and save my order. The rail shows the new order
 * at once. If the save fails, the old order comes back.
 */
export async function reorderWorkspace(fromId: string, toId: string): Promise<void> {
  const before = useWorkspaceStore.getState().workspaces;
  const next = moveWorkspace(before, fromId, toId);
  if (next === before) return;
  useWorkspaceStore.getState().setWorkspaces(next);
  try {
    await api.workspaces.reorder(next.map((w) => w.id));
  } catch {
    // Sort by the old order, not back to `before`: a settings save can replace a workspace meanwhile.
    const rank = new Map(before.map((w, i) => [w.id, i]));
    const current = useWorkspaceStore.getState().workspaces;
    useWorkspaceStore
      .getState()
      .setWorkspaces([...current].sort((a, b) => (rank.get(a.id) ?? before.length) - (rank.get(b.id) ?? before.length)));
    toast.error('Could not save the workspace order');
  }
}

/** How often the rail asks for its badges. Each ask is two narrow reads. */
export const ATTENTION_POLL_MS = 30_000;

const refreshListeners = new Set<() => void>();

/** Ask for the rail's badges now, for example after a session's alert was seen. */
export function refreshContextAttention(): void {
  for (const listener of refreshListeners) listener();
}

/**
 * The rail's last answer. The rail fills it; the sidebar reads the
 * `sessions` part, so the rows that the badge counts show it.
 */
export const useContextAttentionStore = create<{ counts: ContextAttentionCounts | null }>(() => ({ counts: null }));

const NO_SESSIONS: Readonly<Record<string, ContextAttentionReason>> = Object.freeze({});

/** The sessions that the rail's badges count, with their reasons. Empty while the rail is hidden. */
export function useAttentionSessions(): Readonly<Record<string, ContextAttentionReason>> {
  return useContextAttentionStore((s) => s.counts?.sessions ?? NO_SESSIONS);
}

/** Why the rail counts one session, if it does. A row subscribes to its own reason only. */
export function useAttentionReason(id: string): ContextAttentionReason | undefined {
  return useContextAttentionStore((s) => s.counts?.sessions?.[id]);
}

/**
 * The rail's badge counts. Asks on mount, every 30 seconds while the window
 * shows, when the window comes back, when `refreshKey` changes (a context
 * switch, so the context I just left shows its count at once), and on
 * {@link refreshContextAttention}.
 */
export function useContextAttention(enabled: boolean, refreshKey: string): ContextAttentionCounts | null {
  const counts = useContextAttentionStore((s) => s.counts);
  useEffect(() => {
    if (!enabled) {
      useContextAttentionStore.setState({ counts: null });
      return;
    }
    let cancelled = false;
    const load = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      Promise.resolve()
        .then(() => api.workspaces.attention())
        .then((next) => {
          if (!cancelled) useContextAttentionStore.setState({ counts: next });
        })
        .catch(() => {
          // A failed ask keeps the last badges. The next tick tries again.
        });
    };
    load();
    const timer = setInterval(load, ATTENTION_POLL_MS);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', load);
    refreshListeners.add(load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', load);
      refreshListeners.delete(load);
    };
  }, [enabled, refreshKey]);
  return enabled ? counts : null;
}

/**
 * The client's view of the session's alert. It does not match the server's
 * key exactly (the client has no turn counts), but it changes when the alert
 * changes, which is all {@link useAttentionRefresh} needs.
 *
 * A plan that waits for approval is in the transcript only, so the client
 * cannot see it here. While a turn runs the key is `busy`, so the key also
 * changes when a turn ends. Then the rail asks again and sees the plan.
 */
export function clientAttentionKey(
  workbench: Pick<Workbench, 'kind' | 'status' | 'sandboxState' | 'archivedAt'>,
  chats: Pick<WorkbenchChat, 'id' | 'status' | 'queuedMessages'>[],
  pr: { state: string; summary: { mergeable?: string | null } } | null,
): string | null {
  const key = sessionAttentionKey({
    kind: workbench.kind ?? 'session',
    status: workbench.status,
    sandboxState: workbench.sandboxState,
    archivedAt: workbench.archivedAt,
    chats: chats.map((c) => ({ id: c.id, status: c.status, queued: c.queuedMessages?.length ?? 0 })),
    pr: pr ? { state: pr.state, mergeable: pr.summary.mergeable ?? null } : null,
  });
  return key ?? (chats.some((c) => c.status === 'running') ? 'busy' : null);
}

/**
 * Opening a session does not clear its alert: it stays in "Needs you" until I
 * resolve it. When the open session's alert changes (I answered, a retry
 * started, a turn ended), the rail asks again at once, so the row leaves or
 * comes back without the 30-second wait.
 */
export function useAttentionRefresh(attentionKey: string | null): void {
  const last = useRef(attentionKey);
  useEffect(() => {
    if (last.current === attentionKey) return;
    last.current = attentionKey;
    refreshContextAttention();
  }, [attentionKey]);
}
