import { useEffect, useMemo, useState } from 'react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { api, type PRRow } from '../../lib/api';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkbenchStore, visibleChats } from '../../stores/workbenches';
import { opsFor, sandboxUnavailableReason, type WorkbenchOps } from '../../lib/workbenchOps';

export interface RepoGroup {
  repo: string;
  items: Workbench[];
}

/**
 * Live workbenches grouped by repository, repositories alphabetical and
 * workbenches oldest first. Creation order rather than recency, so the ⌘1–9
 * numbers do not move every time an agent writes something.
 */
export function groupByRepository(workbenches: Workbench[]): RepoGroup[] {
  const map = new Map<string, Workbench[]>();
  for (const wb of workbenches) {
    const list = map.get(wb.repoFullName);
    if (list) list.push(wb);
    else map.set(wb.repoFullName, [wb]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, items]) => ({ repo, items: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }));
}

export function isArchived(wb: Workbench): boolean {
  return wb.status === 'archived' || Boolean(wb.archivedAt);
}

/** The workbenches of the current workspace, archived included. */
export function useWorkspaceWorkbenches(): Workbench[] {
  const map = useWorkbenchStore((s) => s.workbenches);
  return useMemo(() => Object.values(map), [map]);
}

/** Live workbenches in sidebar order — the order ⌘1–9 counts in. */
export function useOrderedLiveWorkbenches(): Workbench[] {
  const all = useWorkspaceWorkbenches();
  return useMemo(() => groupByRepository(all.filter((w) => !isArchived(w))).flatMap((g) => g.items), [all]);
}

export function useSelectedWorkbench(): Workbench | null {
  return useWorkbenchStore((s) => (s.selectedWorkbenchId ? (s.workbenches[s.selectedWorkbenchId] ?? null) : null));
}

/** The open chat tab: the remembered one, else the newest visible chat. */
export function useSelectedChat(workbenchId: string): WorkbenchChat | null {
  const chats = useWorkbenchStore((s) => s.chats);
  const hidden = useWorkbenchStore((s) => s.hiddenChatIds);
  const selectedId = useWorkbenchStore((s) => s.selectedChatByWorkbench[workbenchId]);
  return useMemo(() => {
    const visible = visibleChats({ chats, hiddenChatIds: hidden }, workbenchId);
    return visible.find((c) => c.id === selectedId) ?? visible[visible.length - 1] ?? null;
  }, [chats, hidden, selectedId, workbenchId]);
}

export function useWorkbenchOps(workbench: Workbench): WorkbenchOps {
  // Rebuilt only when what the ops close over changes. `settings` is keyed by
  // its JSON: a WS frame hands back a new object each time, which would rebuild
  // the ops (and refetch the changes) on every frame.
  const settingsKey = JSON.stringify(workbench.settings ?? {});
  const reason = workbench.runtime === 'sandbox' ? sandboxUnavailableReason(workbench) : null;
  return useMemo(
    () => opsFor(workbench),
    [
      workbench.id,
      workbench.runtime,
      workbench.localPath,
      workbench.deviceId,
      workbench.baseBranch,
      workbench.branch,
      workbench.status,
      workbench.sandboxState,
      reason,
      settingsKey,
    ]
  );
}

/**
 * The PR this workbench opened. The open-PR store first; a merged or closed
 * PR has left that list, so it is fetched on its own.
 */
export function useWorkbenchPr(workbench: Workbench): PRRow | null {
  const id = workbench.pullRequestId;
  const row = usePullRequestStore((s) => (id ? s.rows.find((r) => r.id === id) : undefined));
  const [fetched, setFetched] = useState<PRRow | null>(null);
  useEffect(() => {
    if (!id || row) return undefined;
    let cancelled = false;
    api.pullRequests
      .get(id)
      .then((res) => {
        if (!cancelled) setFetched(res.row);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, row, workbench.updatedAt]);
  if (!id) return null;
  return row ?? (fetched?.id === id ? fetched : null);
}
