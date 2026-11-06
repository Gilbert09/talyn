import { useState, type ReactNode } from 'react';
import { Check, Loader2, User } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';
import { loadSpaceSessions, loadSpaceTasks, useSpacesStore, type SpacesDialog } from '../../stores/spaces';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { SpaceDot } from './SpaceAvatars';

type MoveDialog = Extract<SpacesDialog, { kind: 'move' }>;

/** Move a session or a task into a space, or back to Personal with null. Owner only; the backend checks. */
export async function moveToSpace(target: 'session' | 'task', id: string, from: string | null, to: string | null): Promise<boolean> {
  try {
    if (target === 'session') {
      const wb = await api.spaces.moveSession(id, to);
      useWorkbenchStore.getState().upsertWorkbench(wb);
      useSpacesStore.getState().applyWorkbench(wb);
    } else {
      const task = await api.spaces.moveTask(id, to);
      useWorkspaceStore.getState().updateTask(id, { spaceId: task.spaceId ?? null });
      useSpacesStore.getState().applyTaskUpdate(id, { spaceId: to });
    }
    const loaded = useSpacesStore.getState()[target === 'session' ? 'sessions' : 'tasks'];
    for (const spaceId of [from, to]) {
      if (spaceId && loaded[spaceId]?.loaded) void (target === 'session' ? loadSpaceSessions(spaceId) : loadSpaceTasks(spaceId));
    }
    const teams = useSpacesStore.getState().teams ?? [];
    const name = to ? teams.flatMap((t) => t.spaces).find((s) => s.id === to)?.name ?? 'the space' : 'Personal';
    toast.success(`Moved to ${name}`);
    return true;
  } catch (err) {
    toast.error('Could not move it', err instanceof Error ? err.message : undefined);
    return false;
  }
}

export function MoveToSpaceDialog() {
  const dialog = useSpacesStore((s) => s.dialog);
  const openDialog = useSpacesStore((s) => s.openDialog);
  const move = dialog?.kind === 'move' ? dialog : null;
  return (
    <Dialog open={move !== null} onOpenChange={(open) => !open && openDialog(null)}>
      {move && <MoveBody move={move} onDone={() => openDialog(null)} />}
    </Dialog>
  );
}

function MoveBody({ move, onDone }: { move: MoveDialog; onDone: () => void }) {
  const teams = useSpacesStore((s) => s.teams) ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const pick = async (to: string | null) => {
    if (to === move.spaceId || busy) return;
    setBusy(to ?? 'personal');
    const ok = await moveToSpace(move.target, move.id, move.spaceId, to);
    setBusy(null);
    if (ok) onDone();
  };
  const row = (key: string, to: string | null, icon: ReactNode, label: string) => (
    <button
      key={key}
      type="button"
      disabled={busy !== null}
      onClick={() => void pick(to)}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-60',
        move.spaceId === to && 'bg-secondary',
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {busy === (to ?? 'personal') ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        move.spaceId === to && <Check className="h-3.5 w-3.5 text-primary" />
      )}
    </button>
  );
  return (
    <DialogContent onClose={onDone} className="max-w-sm">
      <DialogHeader>
        <DialogTitle>{move.target === 'session' ? 'Move session' : 'Move task'}</DialogTitle>
        <DialogDescription>
          In a space, your teammates can see it. It still runs on your account.
        </DialogDescription>
      </DialogHeader>
      <div className="mt-3 space-y-1">
        {row('personal', null, <User className="h-3.5 w-3.5" />, 'Personal')}
        {teams.map((team) => (
          <div key={team.id}>
            <div className="truncate px-2 pb-0.5 pt-2 text-xs font-medium text-muted-foreground">{team.name}</div>
            {team.spaces.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No spaces yet.</p>}
            {team.spaces.map((space) => row(space.id, space.id, <SpaceDot color={space.color} />, space.name))}
          </div>
        ))}
      </div>
    </DialogContent>
  );
}
