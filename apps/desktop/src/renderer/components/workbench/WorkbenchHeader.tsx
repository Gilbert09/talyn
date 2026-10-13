import { useState } from 'react';
import {
  Archive,
  ArrowLeft,
  Check,
  Cloud,
  Copy,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Laptop,
  Loader2,
  PanelBottom,
  Wrench,
  X,
} from 'lucide-react';
import type { Workbench, WorkbenchChat, WorkbenchNextAction } from '@talyn/shared';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { cn } from '../../lib/utils';
import { api, type PRRow } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import { NEXT_ACTION_LABEL, prRowAsLike, workbenchNextAction } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { PrPill } from './WorkbenchSidebar';

const ACTION_ICON: Record<Exclude<WorkbenchNextAction, null>, typeof GitPullRequest> = {
  create_pr: GitPullRequest,
  resolve_conflicts: GitBranch,
  fix_checks: Wrench,
  merge: GitMerge,
  archive: Archive,
};

/**
 * Run a header action. Create PR / Fix checks / Resolve conflicts are prompts
 * to the agent; the backend picks the prompt for a sandbox, the local runtime
 * resolves it here. Merge and Archive have their own confirmations.
 */
export async function runPromptAction(
  ops: WorkbenchOps,
  action: 'create_pr' | 'fix_checks' | 'resolve_conflicts',
  chat: WorkbenchChat | null
): Promise<void> {
  try {
    await ops.runAction(action, chat);
    toast.info(`${NEXT_ACTION_LABEL[action]}: sent to the agent`);
  } catch (err) {
    toast.error(`Could not ${NEXT_ACTION_LABEL[action].toLowerCase()}`, err instanceof Error ? err.message : undefined);
  }
}

export function WorkbenchHeader({
  workbench,
  pr,
  chat,
  ops,
}: {
  workbench: Workbench;
  pr: PRRow | null;
  chat: WorkbenchChat | null;
  ops: WorkbenchOps;
}) {
  const toggleTerminal = useWorkbenchStore((s) => s.toggleTerminal);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<WorkbenchNextAction>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const action = workbenchNextAction(workbench, pr ? prRowAsLike(pr) : null);
  const archived = workbench.status === 'archived' || Boolean(workbench.archivedAt);
  const RuntimeIcon = workbench.runtime === 'local' ? Laptop : Cloud;

  const copyBranch = () => {
    navigator.clipboard
      .writeText(workbench.branch)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error('Could not copy to clipboard'));
  };

  const onAction = async () => {
    if (!action) return;
    if (action === 'merge') return setConfirmMerge(true);
    if (action === 'archive') return setConfirmArchive(true);
    setBusy(action);
    await runPromptAction(ops, action, chat);
    setBusy(null);
  };

  const merge = async () => {
    if (!pr) return;
    setBusy('merge');
    try {
      const res = await api.pullRequests.merge(pr.id);
      if (res.merged) toast.success(`Merged #${pr.number}`, res.message);
      else toast.info(`#${pr.number} was not merged`, res.message);
      setConfirmMerge(false);
    } catch (err) {
      toast.error(`Could not merge #${pr.number}`, err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    setBusy('archive');
    try {
      const wb = await api.workbenches.archive(workbench.id);
      useWorkbenchStore.getState().upsertWorkbench(wb);
      useWorkbenchStore.getState().selectWorkbench(null);
      setConfirmArchive(false);
    } catch (err) {
      toast.error('Could not archive the workbench', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const ActionIcon = action ? ACTION_ICON[action] : null;

  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold">{workbench.name}</h1>
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            title={workbench.runtime === 'local' ? `Local worktree: ${workbench.localPath ?? ''}` : 'Talyn Fleet sandbox'}
          >
            <RuntimeIcon className="h-3 w-3" />
            {workbench.runtime === 'local' ? 'Local' : 'Sandbox'}
          </span>
          {pr && (
            <a href={pr.summary.url} target="_blank" rel="noopener noreferrer" title={pr.summary.title}>
              <PrPill number={pr.number} state={pr.state} draft={pr.summary.draft} />
            </a>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate">{workbench.branch}</span>
          <ArrowLeft className="h-3 w-3 shrink-0 opacity-60" />
          <span className="truncate">{workbench.baseBranch}</span>
          <button
            type="button"
            onClick={copyBranch}
            className="rounded p-0.5 hover:bg-accent hover:text-foreground"
            title="Copy the branch name"
            aria-label="Copy the branch name"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>
      <Button
        variant="ghost"
        className="h-7 w-7 p-0"
        onClick={toggleTerminal}
        title="Toggle the terminal (⌘J)"
        aria-label="Toggle the terminal"
      >
        <PanelBottom className="h-4 w-4" />
      </Button>
      {confirmMerge && pr ? (
        <div className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
          <span>
            Merge #{pr.number} into <span className="font-mono">{pr.summary.baseBranch}</span>?
          </span>
          <Button className="h-6 px-2 text-xs" onClick={() => void merge()} disabled={busy === 'merge'}>
            {busy === 'merge' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Merge'}
          </Button>
          <Button
            variant="ghost"
            className="h-6 w-6 p-0"
            onClick={() => setConfirmMerge(false)}
            disabled={busy === 'merge'}
            aria-label="Cancel merge"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        action &&
        ActionIcon &&
        !archived && (
          <Button
            className={cn('h-7 gap-1.5 px-2.5 text-xs', action === 'archive' && 'bg-muted text-foreground hover:bg-muted/80')}
            onClick={() => void onAction()}
            disabled={busy !== null || Boolean(ops.unavailable && action !== 'merge' && action !== 'archive')}
            title={action === 'create_pr' ? 'Ask the agent to commit, push and open a PR (⌘⇧P)' : NEXT_ACTION_LABEL[action]}
          >
            {busy === action ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ActionIcon className="h-3.5 w-3.5" />}
            {NEXT_ACTION_LABEL[action]}
          </Button>
        )
      )}
      <ConfirmDialog
        open={confirmArchive}
        title={`Archive ${workbench.name}?`}
        description="The workbench moves to the Archived list. The branch, its chats and any PR stay, and you can restore it later."
        confirmLabel="Archive"
        busy={busy === 'archive'}
        onConfirm={() => void archive()}
        onCancel={() => setConfirmArchive(false)}
      />
    </div>
  );
}
