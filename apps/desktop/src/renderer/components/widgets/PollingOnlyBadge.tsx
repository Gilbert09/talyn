import { RefreshCw } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspace';
import { isPollingOnlyOwner, pollingOnlyTooltip } from '../../lib/githubInstall';
import { cn } from '../../lib/utils';

/**
 * Marks a PR whose repo gets no GitHub webhooks, because the Talyn App is not
 * installed on its owner. Reads the banner's coverage answer from the store,
 * so it costs no request. See `isPollingOnlyOwner` for which states count.
 */
export function PollingOnlyBadge({ owner, className }: { owner: string; className?: string }) {
  const installations = useWorkspaceStore((s) => s.githubInstallations);
  const coverage = useWorkspaceStore((s) => s.githubCoverage);
  if (!isPollingOnlyOwner(owner, installations, coverage)) return null;
  return (
    <span
      data-attr="pr-polling-only"
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded bg-zinc-200 px-1 py-0.5 text-[10px] uppercase text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300',
        className
      )}
      title={pollingOnlyTooltip(owner)}
    >
      <RefreshCw className="h-2.5 w-2.5" />
      Polling
    </span>
  );
}
