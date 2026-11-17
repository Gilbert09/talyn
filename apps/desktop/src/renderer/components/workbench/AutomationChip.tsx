import { Repeat, Workflow } from 'lucide-react';
import { sessionAutomation, type WorkbenchSource } from '@talyn/shared';
import { automationsShown, openAutomation } from '../../lib/automationFocus';
import { useWorkspaceStore } from '../../stores/workspace';

/** Header chip for a session an automation started: opens that automation on its integration page. */
export function AutomationChip({ source }: { source: WorkbenchSource | null | undefined }) {
  const features = useWorkspaceStore((s) => s.features);
  const automation = sessionAutomation(source);
  if (!automation || !automationsShown(features, automation.kind)) return null;
  return (
    <button
      type="button"
      onClick={() => openAutomation({ type: automation.type, id: automation.id, kind: automation.kind })}
      data-attr="session-open-automation"
      title={`Started by a ${automation.label} automation: open it`}
      aria-label={`Open the ${automation.label} automation that started this session`}
      className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {automation.type === 'loop' ? <Repeat className="h-3 w-3" /> : <Workflow className="h-3 w-3" />}
      <span className="max-w-[10rem] truncate">{automation.label}</span>
      <span className="text-foreground/70">Open automation</span>
    </button>
  );
}
