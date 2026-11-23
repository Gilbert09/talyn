import { useMemo } from 'react';
import { AlertCircle, Bot, Loader2 } from 'lucide-react';
import { subagentCardModel, subagentTabs, type SubagentTab, type WorkbenchEvent } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { useWorkbenchStore } from '../../stores/workbenches';

/** The chat's subagent tabs and the tab shown. No tabs while the session-subagents flag is off. */
export function useSubagentTabs(chatId: string | null, events: WorkbenchEvent[]): { tabs: SubagentTab[]; current: SubagentTab | null } {
  const enabled = useWorkspaceStore((s) => s.features?.sessionSubagents === true);
  const selected = useWorkbenchStore((s) => (chatId ? s.subagentTab[chatId] ?? null : null));
  const tabs = useMemo(() => (enabled && chatId ? subagentTabs(events, selected) : []), [enabled, chatId, events, selected]);
  return { tabs, current: tabs.find((tab) => tab.toolId === selected) ?? null };
}

/** Tabs above the transcript: the main transcript, then one per subagent. */
export function SubagentTabBar({ chatId, tabs, current }: { chatId: string; tabs: SubagentTab[]; current: SubagentTab | null }) {
  const open = useWorkbenchStore((s) => s.openSubagentTab);
  return (
    <div role="tablist" aria-label="Transcript" data-testid="subagent-tabs"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2 py-1">
      <TabButton selected={!current} label="Main transcript" onClick={() => open(chatId, null)}>Main</TabButton>
      {tabs.map((tab) => {
        const model = subagentCardModel(tab.block, true)!;
        const title = model.title || model.type;
        return (
          <TabButton key={tab.toolId} selected={current?.toolId === tab.toolId} onClick={() => open(chatId, tab.toolId)}
            label={`Subagent ${title}${model.running ? ', running' : model.failed ? ', failed' : ''}`}>
            {model.running ? <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin" />
              : model.failed ? <AlertCircle aria-hidden className="h-3 w-3 shrink-0 text-destructive" />
                : <Bot aria-hidden className="h-3 w-3 shrink-0" />}
            <span className="min-w-0 truncate">{title}</span>
          </TabButton>
        );
      })}
    </div>
  );
}

function TabButton({ selected, label, onClick, children }: { selected: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={selected} aria-label={label} title={label} onClick={onClick}
      className={cn('inline-flex max-w-[14rem] shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs',
        selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
      {children}
    </button>
  );
}
