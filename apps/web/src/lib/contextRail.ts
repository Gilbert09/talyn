import { useEffect, useState } from 'react';
import {
  sessionAttentionKey,
  type ContextAttentionCounts,
  type SpacesTeam,
  type Workbench,
  type WorkbenchChat,
  type Workspace,
  type WorkspaceLogo,
} from '@talyn/shared';
import { api } from './api';
import type { AppContext } from '../stores/workspace';

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

export function railEntryAttention(entry: RailEntry, counts: ContextAttentionCounts | null): number {
  if (!counts) return 0;
  return (entry.kind === 'workspace' ? counts.workspaces[entry.id] : counts.spaces[entry.id]) ?? 0;
}

/** Up to two letters for a space tile: "Growth" -> "G", "Data Platform" -> "DP". */
export function railInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? [...words[0]].slice(0, 1) : [[...words[0]][0], [...words[1]][0]];
  return letters.join('').toUpperCase();
}

/** How often the rail asks for its badges. Each ask is two narrow reads. */
export const ATTENTION_POLL_MS = 30_000;

const refreshListeners = new Set<() => void>();

/** Ask for the rail's badges now, for example after a session's alert was seen. */
export function refreshContextAttention(): void {
  for (const listener of refreshListeners) listener();
}

/**
 * The rail's badge counts. Asks on mount, every 30 seconds while the window
 * shows, when the window comes back, when `refreshKey` changes (a context
 * switch, so the context I just left shows its count at once), and on
 * {@link refreshContextAttention}.
 */
export function useContextAttention(enabled: boolean, refreshKey: string): ContextAttentionCounts | null {
  const [counts, setCounts] = useState<ContextAttentionCounts | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      Promise.resolve()
        .then(() => api.workspaces.attention())
        .then((next) => {
          if (!cancelled) setCounts(next);
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
 * changes, which is all {@link useAttentionSeen} needs.
 */
export function clientAttentionKey(
  workbench: Pick<Workbench, 'kind' | 'status' | 'sandboxState' | 'archivedAt'>,
  chats: Pick<WorkbenchChat, 'id' | 'status' | 'queuedMessages'>[],
  pr: { state: string; summary: { mergeable?: string | null } } | null,
): string | null {
  return sessionAttentionKey({
    kind: workbench.kind ?? 'session',
    status: workbench.status,
    sandboxState: workbench.sandboxState,
    archivedAt: workbench.archivedAt,
    chats: chats.map((c) => ({ id: c.id, status: c.status, queued: c.queuedMessages?.length ?? 0 })),
    pr: pr ? { state: pr.state, mergeable: pr.summary.mergeable ?? null } : null,
  });
}

/** Tell the server I saw the session's alert, then ask for the rail's badges again. */
export function markAttentionSeen(workbenchId: string): void {
  Promise.resolve()
    .then(() => api.workbenches.attentionSeen(workbenchId))
    .then(() => refreshContextAttention())
    .catch(() => {
      // A teammate's session or a lost request: the badge stays until the next open.
    });
}

/**
 * Looking at a session sees its alert, so the context rail stops counting it.
 * Runs when the session opens, when its alert changes while it is open, and
 * when the window comes back with an alert showing.
 */
export function useAttentionSeen(workbenchId: string, attentionKey: string | null): void {
  useEffect(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return undefined;
    markAttentionSeen(workbenchId);
    return undefined;
  }, [workbenchId, attentionKey]);
  useEffect(() => {
    if (attentionKey === null) return undefined;
    const onFocus = () => markAttentionSeen(workbenchId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [workbenchId, attentionKey]);
}
