import { useMemo, type ReactNode } from 'react';
import type { Workbench } from '@talyn/shared';
import { useAttentionSessions } from '../../lib/contextRail';
import { useNavigationStore } from '../../stores/navigation';
import { useSplitViewStore } from '../../stores/splitView';
import { isArchived } from '../workbench/workbenchSelectors';
import { WorkbenchRow } from './SidebarWorkbenchList';

/**
 * The sessions that the context rail's red badge counts for this context, at
 * the top of the sidebar. The badge says how many; this says which, so I do
 * not have to scroll the list to find them. A session stays here until I
 * resolve what it waits on. Opening it does not remove it.
 */
export function SidebarNeedsYou<T extends { id: string }>({
  items,
  renderItem,
}: {
  items: readonly T[];
  renderItem: (item: T) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div role="group" aria-label="Needs you" data-attr="sidebar-needs-you">
      <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-red-500">
        <span className="flex-1">Needs you</span>
        <span className="tabular-nums">{items.length}</span>
      </div>
      {items.map(renderItem)}
    </div>
  );
}

/** The items of `list` that the rail counts, in the list's order. */
export function useNeedsYouItems<T extends { id: string }>(list: readonly T[], live: (item: T) => boolean): T[] {
  const attention = useAttentionSessions();
  return useMemo(() => list.filter((item) => attention[item.id] && live(item)), [list, attention, live]);
}

const isLive = (workbench: Workbench) => !isArchived(workbench);

/** The Personal sidebar's "Needs you" section. */
export function PersonalNeedsYou({ workbenches }: { workbenches: Workbench[] }) {
  const route = useNavigationStore((s) => s.route);
  const navigate = useNavigationStore((s) => s.navigate);
  const splitPanes = useSplitViewStore((s) => s.panes);
  const addPane = useSplitViewStore((s) => s.addPane);
  const items = useNeedsYouItems(workbenches, isLive);
  const inSplit = route.view === 'split';
  const openId = route.view === 'workbench' ? route.id : null;
  return (
    <SidebarNeedsYou
      items={items}
      renderItem={(wb) => (
        <WorkbenchRow
          key={wb.id}
          workbench={wb}
          shortcut={null}
          selected={inSplit ? splitPanes.includes(wb.id) : wb.id === openId}
          onSelect={() => (inSplit ? addPane(wb.id, 'sidebar') : navigate({ view: 'workbench', id: wb.id }))}
        />
      )}
    />
  );
}
