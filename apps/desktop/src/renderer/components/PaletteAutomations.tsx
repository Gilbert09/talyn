import { useEffect, useMemo, useState } from 'react';
import { Repeat, Workflow } from 'lucide-react';
import { INTEGRATION_CATALOG, workflowIntegrationOf } from '@talyn/shared';
import { api } from '../lib/api';
import { automationsShown, openAutomation, type AutomationTarget } from '../lib/automationFocus';
import type { PaletteSection } from '../lib/paletteSearch';
import { useWorkspaceStore } from '../stores/workspace';

interface PaletteAutomation extends AutomationTarget {
  name: string;
  enabled: boolean;
}

/**
 * The palette's Automations section: every rule and scheduled loop in the
 * workspace, read once when the palette opens. Search only, like the archived
 * sessions, so the open palette stays short.
 */
export function usePaletteAutomationsSection(pick: (fn: () => void) => void): PaletteSection | null {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const features = useWorkspaceStore((s) => s.features);
  const [cache, setCache] = useState<{ workspaceId: string; rows: PaletteAutomation[] } | null>(null);
  const rulesShown = (['github', 'github_issues', 'linear', 'slack', 'webhook'] as const).some((kind) =>
    automationsShown(features, kind)
  );
  const loopsShown = automationsShown(features, 'schedule');

  useEffect(() => {
    if (!workspaceId || (!rulesShown && !loopsShown)) return;
    let active = true;
    const rules = rulesShown
      ? api.workflows.list(workspaceId).then(
          (list) =>
            list.map((w): PaletteAutomation => ({
              type: 'workflow',
              id: w.id,
              kind: workflowIntegrationOf(w),
              name: w.name,
              enabled: w.enabled,
            })),
          () => []
        )
      : Promise.resolve([]);
    const loops = loopsShown
      ? api.loops.list(workspaceId).then(
          (list) =>
            list.map((l): PaletteAutomation => ({
              type: 'loop',
              id: l.id,
              kind: 'schedule',
              name: l.name,
              enabled: l.enabled,
            })),
          () => []
        )
      : Promise.resolve([]);
    void Promise.all([rules, loops]).then(([a, b]) => {
      if (active) setCache({ workspaceId, rows: [...a, ...b] });
    });
    return () => {
      active = false;
    };
  }, [workspaceId, rulesShown, loopsShown]);

  const rows = useMemo(
    () =>
      cache?.workspaceId === workspaceId
        ? cache.rows
            .filter((row) => automationsShown(features, row.kind))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [cache, workspaceId, features]
  );

  if (rows.length === 0) return null;
  return {
    id: 'automations',
    heading: 'Automations',
    kind: 'Automation',
    searchOnly: true,
    entries: rows.map((row) => {
      const integration = INTEGRATION_CATALOG[row.kind].name;
      const Icon = row.type === 'loop' ? Repeat : Workflow;
      return {
        id: `automation:${row.type}:${row.id}`,
        label: row.name,
        keywords: [integration, 'automation', row.id],
        onSelect: () => pick(() => openAutomation({ type: row.type, id: row.id, kind: row.kind })),
        content: (
          <>
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{row.name}</span>
            <span className="truncate text-[11px] text-muted-foreground">{integration}</span>
            {!row.enabled && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">Off</span>}
          </>
        ),
      };
    }),
  };
}
