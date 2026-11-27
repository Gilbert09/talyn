import { Loader2 } from 'lucide-react';
import type { WorkbenchCreation } from '@talyn/shared';
import { useSpacesStore } from '../stores/spaces';
import { useWorkbenchStore } from '../stores/workbenches';
import { WorkbenchView } from '../components/workbench/WorkbenchView';

/**
 * The workbench route. Loading the list, keeping the selection in step and
 * leaving a route whose workbench has gone are the shell's job
 * (`useWorkbenchList` + `reconcileWorkbenchRoute`); this only draws.
 */
export function WorkbenchPage({ id, creation }: { id?: string; creation?: WorkbenchCreation }) {
  const workbench = useWorkbenchStore((s) => id ? s.workbenches[id] : undefined);
  const extraLoading = useSpacesStore((s) => id && s.extraLoads[id] === 'loading');
  const listLoaded = useWorkbenchStore((s) => s.listLoaded);
  const listError = useWorkbenchStore((s) => s.listError);

  const item = creation?.workbench ?? workbench;
  if (item) return <WorkbenchView key={item.id} workbench={item} creation={creation} />;
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      {listLoaded && !extraLoading ? (
        (listError ?? 'This session is not available.')
      ) : (
        <>
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the session…
        </>
      )}
    </div>
  );
}
