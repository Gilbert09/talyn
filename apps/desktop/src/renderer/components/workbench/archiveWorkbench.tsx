import { useEffect, useState } from 'react';
import { workbenchDisplayName, type LocalWorktreeStatus, type Workbench, type WorkbenchLocalBridge } from '@talyn/shared';
import { stopCoderPreview } from '../../lib/coderPreview';
import { bridgeErrorMessage, getDeviceId, getWorkbenchBridge } from '../../lib/workbenchBridge';
import { stopLocalWorkbench } from '../../lib/localWorkbench';
import { markDialogArchive } from '../../lib/localArchive';
import { detectedCheckout, takeOverLocalWorkbench } from '../../lib/localTakeover';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import { ConfirmDialog } from '../ui/confirm-dialog';

export interface ArchiveOptions {
  /** The person saw the uncommitted changes in the dialog and chose to lose them. */
  discardChanges?: boolean;
}

type LocalFields = Partial<Pick<Workbench, 'id' | 'runtime' | 'deviceId' | 'localPath'>>;

/** A local session whose worktree is on this computer. */
export function ownsLocalWorktree(workbench: LocalFields): boolean {
  return (
    workbench.runtime === 'local' &&
    Boolean(workbench.localPath) &&
    (!workbench.deviceId || workbench.deviceId === getDeviceId())
  );
}

/** Archive a session. `leave` clears the selection when the session is the open one. */
export async function archiveWorkbench(id: string, leave: boolean, opts: ArchiveOptions = {}): Promise<boolean> {
  markDialogArchive(id, true);
  try {
    const wb = await api.workbenches.archive(id);
    useWorkbenchStore.getState().upsertWorkbench(wb);
    // An archived sandbox loses its box. A local session's agent and dev server run here, so stop them.
    if (ownsLocalWorktree(wb)) {
      await stopLocalWorkbench(id).catch((err) => {
        toast.error('Could not stop the session on this computer', bridgeErrorMessage(err, ''));
      });
      await removeLocalWorktree(wb, opts.discardChanges === true);
    }
    stopCoderPreview(id);
    await getWorkbenchBridge()?.preview?.stop(id).catch(() => {
      toast.error('Could not stop the preview');
    });
    if (leave) useWorkbenchStore.getState().selectWorkbench(null);
    return true;
  } catch (err) {
    toast.error('Could not archive the session', err instanceof Error ? err.message : undefined);
    return false;
  } finally {
    markDialogArchive(id, false);
  }
}

/**
 * Delete an archived session's worktree. The branch stays in the repository,
 * so a restore can make the worktree again. Never throws: a failure keeps the
 * folder and says so.
 */
export async function removeLocalWorktree(
  workbench: Pick<Workbench, 'id' | 'localPath'>,
  discardChanges: boolean,
  bridge: Pick<WorkbenchLocalBridge, 'removeWorktree'> | null = getWorkbenchBridge()
): Promise<boolean> {
  if (!bridge || !workbench.localPath) return false;
  try {
    await bridge.removeWorktree({ path: workbench.localPath, workbenchId: workbench.id, force: discardChanges });
    return true;
  } catch (err) {
    toast.error(
      'Could not delete the worktree',
      `${bridgeErrorMessage(err, 'Git refused.')} The session is archived. Its folder stays at ${workbench.localPath}.`
    );
    return false;
  }
}

/**
 * Restore a session from History. A local one gets its worktree back first,
 * from its branch, so the session never comes back without its folder.
 */
export async function restoreWorkbench(
  workbench: Workbench,
  bridge: Pick<WorkbenchLocalBridge, 'restoreWorktree'> | null = getWorkbenchBridge()
): Promise<Workbench | null> {
  try {
    if (workbench.runtime === 'local' && workbench.localPath) {
      if (workbench.deviceId && workbench.deviceId !== getDeviceId()) {
        const checkout = await detectedCheckout(workbench.repoFullName);
        if (checkout) await takeOverLocalWorkbench(workbench, checkout);
      } else {
        if (!bridge) throw new Error('A local session needs the Talyn desktop app.');
        if (bridge.restoreWorktree) {
          const made = await bridge.restoreWorktree({ path: workbench.localPath, workbenchId: workbench.id, branch: workbench.branch });
          if (!made.ok) throw new Error(made.message);
        }
      }
    }
    const wb = await api.workbenches.restore(workbench.id);
    useWorkbenchStore.getState().upsertWorkbench(wb);
    return wb;
  } catch (err) {
    toast.error('Could not restore the session', bridgeErrorMessage(err, 'Try again.'));
    return null;
  }
}

type WorktreeCheck =
  | { state: 'none' }
  | { state: 'checking' }
  | { state: 'failed' }
  | { state: 'ready'; status: LocalWorktreeStatus };

/** What an archive would delete, read while the dialog is open. */
export function useWorktreeCheck(workbench: LocalFields, open: boolean): WorktreeCheck {
  const [check, setCheck] = useState<WorktreeCheck>({ state: 'none' });
  const local = ownsLocalWorktree(workbench);
  const path = workbench.localPath;
  useEffect(() => {
    const inspect = getWorkbenchBridge()?.inspectWorktree;
    if (!open || !local || !path || !inspect) {
      setCheck({ state: 'none' });
      return undefined;
    }
    let cancelled = false;
    setCheck({ state: 'checking' });
    inspect(path)
      .then((status) => { if (!cancelled) setCheck({ state: 'ready', status }); })
      .catch(() => { if (!cancelled) setCheck({ state: 'failed' }); });
    return () => {
      cancelled = true;
    };
  }, [open, local, path]);
  return check;
}

const SHOWN_FILES = 5;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function WorktreeNote({ check, localPath }: { check: WorktreeCheck; localPath: string }) {
  if (check.state === 'none') {
    return <span className="mt-2 block">Talyn deletes the worktree folder {localPath} from this computer.</span>;
  }
  if (check.state === 'checking') return <span className="mt-2 block">Checking the worktree for changes…</span>;
  if (check.state === 'failed') {
    return (
      <span className="mt-2 block">
        Talyn deletes the worktree folder {localPath}. It could not check the folder for changes, so it keeps the folder if
        it has any.
      </span>
    );
  }
  const { status } = check;
  if (!status.exists) return null;
  const hidden = status.uncommittedCount - Math.min(status.uncommitted.length, SHOWN_FILES);
  return (
    <>
      {status.uncommittedCount > 0 ? (
        <>
          <span className="mt-2 block font-medium text-destructive">
            Talyn deletes the worktree folder {localPath}. Its {plural(status.uncommittedCount, 'uncommitted change', 'uncommitted changes')}{' '}
            will be lost:
          </span>
          {status.uncommitted.slice(0, SHOWN_FILES).map((file) => (
            <span key={file} className="block truncate font-mono text-xs">
              {file}
            </span>
          ))}
          {hidden > 0 ? <span className="block text-xs">and {hidden} more</span> : null}
        </>
      ) : (
        <span className="mt-2 block">
          Talyn deletes the worktree folder {localPath} from this computer. A restore makes it again from the branch.
        </span>
      )}
      {status.unpushed ? (
        <span className="mt-2 block">
          {plural(status.unpushed, 'commit is', 'commits are')} not pushed. They stay on the local branch
          {status.branch ? ` ${status.branch}` : ''}.
        </span>
      ) : null}
    </>
  );
}

export function ArchiveWorkbenchDialog({
  workbench,
  open,
  busy,
  onConfirm,
  onCancel,
}: {
  workbench: Pick<Workbench, 'name' | 'title'> & LocalFields;
  open: boolean;
  busy: boolean;
  onConfirm: (opts: ArchiveOptions) => void;
  onCancel: () => void;
}) {
  const check = useWorktreeCheck(workbench, open);
  const local = ownsLocalWorktree(workbench);
  const dirty = check.state === 'ready' && check.status.uncommittedCount > 0;
  return (
    <ConfirmDialog
      open={open}
      title={`Archive ${workbenchDisplayName(workbench)}?`}
      description={
        <>
          <span className="block">The session moves to History. The branch, its chats and any PR stay, and you can restore it later.</span>
          {local && workbench.localPath ? <WorktreeNote check={check} localPath={workbench.localPath} /> : null}
        </>
      }
      confirmLabel={dirty ? 'Archive and lose changes' : 'Archive'}
      busy={busy}
      confirmDisabled={check.state === 'checking'}
      onConfirm={() => onConfirm({ discardChanges: dirty })}
      onCancel={onCancel}
    />
  );
}
