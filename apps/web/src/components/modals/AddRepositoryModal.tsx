import { useWorkspaceStore } from '../../stores/workspace';
import { useNavigationStore } from '../../stores/navigation';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { WatchReposStep } from '../onboarding/steps/WatchReposStep';

export function AddRepositoryModal() {
  const open = useNavigationStore((s) => s.addRepositoryOpen);
  const setOpen = useNavigationStore((s) => s.setAddRepositoryOpen);
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  if (!open || !workspaceId) return null;
  const close = () => setOpen(false);
  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-xl" onClose={close}>
        <DialogHeader>
          <DialogTitle>Add repositories</DialogTitle>
        </DialogHeader>
        <WatchReposStep workspaceId={workspaceId} />
        <DialogFooter>
          <Button size="sm" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
