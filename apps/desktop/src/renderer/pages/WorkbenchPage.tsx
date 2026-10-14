import { Loader2 } from 'lucide-react';
import { useWorkbenchStore } from '../stores/workbenches';
import { WorkbenchView } from '../components/workbench/WorkbenchView';

/**
 * The workbench route. Loading the list, keeping the selection in step and
 * leaving a route whose workbench has gone are the shell's job
 * (`useWorkbenchList` + `reconcileWorkbenchRoute`); this only draws.
 */
export function WorkbenchPage({ id }: { id: string }) {
  const workbench = useWorkbenchStore((s) => s.workbenches[id]);
  const listLoaded = useWorkbenchStore((s) => s.listLoaded);
  const listError = useWorkbenchStore((s) => s.listError);

  if (workbench) return <WorkbenchView key={workbench.id} workbench={workbench} />;
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      {listLoaded ? (
        (listError ?? 'This workbench is not available.')
      ) : (
        <>
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the workbench…
        </>
      )}
    </div>
  );
}
