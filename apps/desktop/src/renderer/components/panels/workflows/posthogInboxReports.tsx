import { useEffect, useState } from 'react';
import type { WorkflowWithStats } from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException } from '../../../lib/analytics';
import { useWorkspaceStore } from '../../../stores/workspace';
import { ScrollArea } from '../../ui/scroll-area';
import { Select } from '../../ui/select';
import { PostHogInboxBacklog } from './posthogInboxBacklog';

/**
 * The Reports tab of the PostHog Inbox page: pick an automation and see the
 * reports in the PostHog Inbox that it matches, up to all time, with an exact
 * count. It is the same backlog as the automation's own Backlog tab.
 *
 * The same file is in apps/web/src/components/panels/workflows/. Keep the two in step.
 */
export function PostHogInboxReports() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [rules, setRules] = useState<WorkflowWithStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setRules(null);
    setError(null);
    api.workflows
      .list(workspaceId, 'posthog_inbox')
      .then((rows) => {
        if (!cancelled) setRules(rows);
      })
      .catch((err: unknown) => {
        captureAnalyticsException(err, { flow: 'posthog_inbox_reports' });
        if (!cancelled) {
          setRules([]);
          setError(err instanceof Error && err.message ? err.message : 'Could not load the automations.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const chosen = rules?.find((r) => r.id === chosenId) ?? rules?.[0] ?? null;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-4xl space-y-4 p-6" data-attr="posthog-inbox-reports">
        <div>
          <h2 className="text-base font-semibold">Reports</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            See the reports in your PostHog Inbox that an automation matches, also the reports from before you made it. Talyn reads
            them from PostHog with the automation&apos;s filters. You can start work on the reports that did not run.
          </p>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        {rules === null && !error && <p className="text-sm text-muted-foreground">Loading the automations...</p>}
        {rules !== null && rules.length === 0 && !error && (
          <p className="text-sm text-muted-foreground" data-attr="posthog-inbox-reports-empty">
            Make a PostHog Inbox automation on the Automations tab first. Then this tab shows the reports that it matches.
          </p>
        )}
        {chosen && (
          <>
            <div className="max-w-sm">
              <Select
                label="Automation"
                aria-label="Automation"
                value={chosen.id}
                onChange={(e) => setChosenId(e.target.value)}
                data-attr="posthog-inbox-reports-rule"
              >
                {(rules ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.enabled ? r.name : `${r.name} (off)`}
                  </option>
                ))}
              </Select>
            </div>
            <PostHogInboxBacklog key={chosen.id} workflow={chosen} autoLoad showHeader={false} />
          </>
        )}
      </div>
    </ScrollArea>
  );
}
