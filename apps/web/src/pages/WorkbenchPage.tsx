import { Loader2 } from 'lucide-react';
import { useWorkbenchStore } from '../stores/workbenches';
import { WorkbenchView } from '../components/workbench/WorkbenchView';

export function WorkbenchPage({ id }: { id: string }) {
  const workbench = useWorkbenchStore((s) => s.workbenches[id]);
  const listLoaded = useWorkbenchStore((s) => s.listLoaded);
  const listError = useWorkbenchStore((s) => s.listError);

  if (workbench) return <WorkbenchView key={workbench.id} workbench={workbench} />;
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      {listLoaded ? (
        (listError ?? 'This session is not available.')
      ) : (
        <>
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the session…
        </>
      )}
    </div>
  );
}
