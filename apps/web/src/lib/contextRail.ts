import { useEffect, useState } from 'react';
import type { ContextAttentionCounts, SpacesTeam, Workspace, WorkspaceLogo } from '@talyn/shared';
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

/**
 * The rail's badge counts. Asks on mount, every 30 seconds while the window
 * shows, when the window comes back, and when `refreshKey` changes (a context
 * switch, so the context I just left shows its count at once).
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
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', load);
    };
  }, [enabled, refreshKey]);
  return enabled ? counts : null;
}
