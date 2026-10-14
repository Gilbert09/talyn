import { useEffect } from 'react';
import { useWorkspaceStore } from '../stores/workspace';
import { useNavigationStore, type AutomationTab } from '../stores/navigation';
import { AUTOMATION_TAB_LABEL, offeredAutomationTabs } from '../lib/routeLabels';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { WorkflowsPanel } from '../components/panels/workflows/WorkflowsPanel';
import { LoopsPanel } from '../components/panels/loops/LoopsPanel';
import { McpServersPanel } from '../components/panels/mcpServers/McpServersPanel';

/** Workflows, Loops and MCP servers behind one tab strip, unchanged inside. */
export function AutomationsView({ tab }: { tab: AutomationTab }) {
  const features = useWorkspaceStore((s) => s.features);
  const navigate = useNavigationStore((s) => s.navigate);
  const tabs = offeredAutomationTabs(features);
  const shown = tabs.includes(tab) ? tab : null;
  const fallback = tabs[0] ?? null;

  // A remembered tab for a flag this account no longer has moves to one it does.
  useEffect(() => {
    if (features === null || shown) return;
    if (fallback) navigate({ view: 'automations', tab: fallback }, { replace: true });
    else navigate({ view: 'home' }, { replace: true });
  }, [features, shown, fallback, navigate]);

  if (!shown) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-4 border-b px-4 py-1.5">
        <h1 className="text-[13px] font-semibold">Automations</h1>
        <Tabs value={shown} onValueChange={(next) => navigate({ view: 'automations', tab: next as AutomationTab })}>
          <TabsList aria-label="Automations">
            {tabs.map((t) => (
              <TabsTrigger key={t} value={t} data-attr={`automations-tab-${t}`}>
                {AUTOMATION_TAB_LABEL[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {shown === 'workflows' && <WorkflowsPanel />}
        {shown === 'loops' && <LoopsPanel />}
        {shown === 'mcp_servers' && <McpServersPanel />}
      </div>
    </div>
  );
}
