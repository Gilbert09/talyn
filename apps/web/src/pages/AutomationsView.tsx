import { Suspense, useEffect } from 'react';
import { useWorkspaceStore } from '../stores/workspace';
import { useNavigationStore, type AutomationTab } from '../stores/navigation';
import { AUTOMATION_TAB_LABEL, offeredAutomationTabs } from '../lib/routeLabels';
import { PageHeader } from '../components/ui/page-header';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { lazyWithReload } from '../lib/lazyWithReload';
const WorkflowsPanel = lazyWithReload(() =>
  import('../components/panels/workflows/WorkflowsPanel').then((m) => ({ default: m.WorkflowsPanel }))
);
const LoopsPanel = lazyWithReload(() => import('../components/panels/loops/LoopsPanel').then((m) => ({ default: m.LoopsPanel })));

export function AutomationsView({ tab }: { tab: AutomationTab }) {
  const features = useWorkspaceStore((s) => s.features);
  const navigate = useNavigationStore((s) => s.navigate);
  const tabs = offeredAutomationTabs(features);
  const shown = tabs.includes(tab) ? tab : null;
  const fallback = tabs[0] ?? null;
  useEffect(() => {
    if (features === null || shown) return;
    if (fallback) navigate({ view: 'automations', tab: fallback }, { replace: true });
    else navigate({ view: 'home' }, { replace: true });
  }, [features, shown, fallback, navigate]);

  if (!shown) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Automations" className="gap-4">
        <Tabs value={shown} onValueChange={(next) => navigate({ view: 'automations', tab: next as AutomationTab })}>
          <TabsList aria-label="Automations">
            {tabs.map((t) => (
              <TabsTrigger key={t} value={t} data-attr={`automations-tab-${t}`}>
                {AUTOMATION_TAB_LABEL[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={null}>
          {shown === 'workflows' && <WorkflowsPanel />}
          {shown === 'loops' && <LoopsPanel />}
        </Suspense>
      </div>
    </div>
  );
}
