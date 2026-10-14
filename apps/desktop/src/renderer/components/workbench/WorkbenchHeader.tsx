import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Laptop,
  Loader2,
  PanelBottom,
  PanelRight,
  Wrench,
} from 'lucide-react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { cn } from '../../lib/utils';
import { api, type PRRow } from '../../lib/api';
import { formatKeys } from '../../lib/shortcuts';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import { NEXT_ACTION_LABEL, prRowAsLike } from '../../lib/workbenchFormat';
import {
  PROMPT_ACTIONS,
  WORKBENCH_ACTION_EVENT,
  availableWorkbenchActions,
  isArchivedWorkbench,
  primaryWorkbenchAction,
  workbenchActionKeys,
  type WorkbenchAction,
  type WorkbenchActionRequest,
} from '../../lib/workbenchActions';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { PrPill } from './WorkbenchBadges';

const ACTION_ICON: Record<WorkbenchAction, typeof GitPullRequest> = {
  create_pr: GitPullRequest,
  resolve_conflicts: GitBranch,
  fix_checks: Wrench,
  merge: GitMerge,
  archive: Archive,
};

const ACTION_HINT: Record<WorkbenchAction, string> = {
  create_pr: 'Ask the agent to commit, push and open a pull request',
  resolve_conflicts: 'Ask the agent to merge the base branch in and resolve the conflicts',
  fix_checks: 'Ask the agent to fix the failing checks; the prompt carries each failing check and its link',
  merge: 'Merge the pull request on GitHub',
  archive: 'Archive this session',
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

function keysLabel(action: WorkbenchAction): string | null {
  const keys = workbenchActionKeys(action);
  return keys ? formatKeys(keys) : null;
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
  const toggleRightPanel = useWorkbenchStore((s) => s.toggleRightPanel);
  const rightPanelOpen = useWorkbenchStore((s) => s.rightPanelOpen);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<WorkbenchAction | null>(null);
  const [confirm, setConfirm] = useState<'merge' | 'archive' | null>(null);

  const prLike = pr ? prRowAsLike(pr) : null;
  const primary = primaryWorkbenchAction(workbench, prLike);
  const available = availableWorkbenchActions(workbench, prLike);
  const archived = isArchivedWorkbench(workbench);
  const RuntimeIcon = workbench.runtime === 'local' ? Laptop : Cloud;

  const disabled = (action: WorkbenchAction) =>
    busy !== null || (PROMPT_ACTIONS.has(action) && Boolean(ops.unavailable)) || (action === 'merge' && !pr);

  const copyBranch = () => {
    navigator.clipboard
      .writeText(workbench.branch)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error('Could not copy to clipboard'));
  };

  const run = useCallback(
    async (action: WorkbenchAction) => {
      if (action === 'merge' || action === 'archive') {
        setConfirm(action);
        return;
      }
      setBusy(action);
      await runPromptAction(ops, action, chat);
      setBusy(null);
    },
    [ops, chat]
  );

  // Shortcuts and the palette ask through an event, so they get the same
  // confirmations and busy state as a click.
  const latest = useRef({ available, run, disabled, workbenchId: workbench.id });
  latest.current = { available, run, disabled, workbenchId: workbench.id };
  useEffect(() => {
    const onRequest = (e: Event) => {
      const { workbenchId, action } = (e as CustomEvent<WorkbenchActionRequest>).detail ?? {};
      const cur = latest.current;
      if (workbenchId !== cur.workbenchId || !action) return;
      if (!cur.available.includes(action)) {
        toast.info(`${NEXT_ACTION_LABEL[action]} does not apply to this session now`);
        return;
      }
      if (cur.disabled(action)) return;
      void cur.run(action);
    };
    window.addEventListener(WORKBENCH_ACTION_EVENT, onRequest);
    return () => window.removeEventListener(WORKBENCH_ACTION_EVENT, onRequest);
  }, []);

  const merge = async () => {
    if (!pr) return;
    setBusy('merge');
    try {
      const res = await api.pullRequests.merge(pr.id);
      if (res.merged) toast.success(`Merged #${pr.number}`, res.message);
      else toast.info(`#${pr.number} was not merged`, res.message);
      setConfirm(null);
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
      setConfirm(null);
    } catch (err) {
      toast.error('Could not archive the session', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const PrimaryIcon = primary ? ACTION_ICON[primary] : null;
  const primaryKeys = primary ? keysLabel(primary) : null;

  return (
    <div className="app-region-drag flex items-center gap-2 border-b px-3 py-1.5">
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
            <a
              href={pr.summary.url}
              target="_blank"
              rel="noopener noreferrer"
              title={pr.summary.title}
              className="app-region-no-drag"
            >
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
            className="app-region-no-drag rounded p-0.5 hover:bg-accent hover:text-foreground"
            title="Copy the branch name"
            aria-label="Copy the branch name"
          >
            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>
      <Button
        variant="ghost"
        className="h-7 w-7 p-0"
        onClick={toggleTerminal}
        title={`Toggle the terminal (${formatKeys('mod+j')})`}
        aria-label="Toggle the terminal"
      >
        <PanelBottom className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        className={cn('h-7 w-7 p-0', !rightPanelOpen && 'text-muted-foreground')}
        onClick={toggleRightPanel}
        title={`${rightPanelOpen ? 'Hide' : 'Show'} the right panel (${formatKeys('mod+alt+b')})`}
        aria-label="Toggle the right panel"
        aria-pressed={rightPanelOpen}
      >
        <PanelRight className="h-4 w-4" />
      </Button>
      {!archived && (
        <div className="flex items-center">
          {primary && PrimaryIcon && (
            <Button
              className={cn(
                'h-7 gap-1.5 rounded-r-none px-2.5 text-xs',
                primary === 'archive' && 'bg-muted text-foreground hover:bg-muted/80'
              )}
              onClick={() => void run(primary)}
              disabled={disabled(primary)}
              title={`${ACTION_HINT[primary]}${primaryKeys ? ` (${primaryKeys})` : ''}`}
              data-testid="workbench-primary-action"
            >
              {busy === primary ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PrimaryIcon className="h-3.5 w-3.5" />}
              {NEXT_ACTION_LABEL[primary]}
              {primaryKeys && <span className="ml-0.5 text-[10px] opacity-70">{primaryKeys}</span>}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={primary ? 'default' : 'outline'}
                className={cn(
                  'h-7 px-1.5 text-xs',
                  primary ? 'rounded-l-none border-l border-primary-foreground/20' : 'gap-1 px-2',
                  primary === 'archive' && 'bg-muted text-foreground hover:bg-muted/80'
                )}
                aria-label="More actions"
                disabled={busy !== null}
              >
                {!primary && 'Actions'}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              {available.map((action) => {
                const Icon = ACTION_ICON[action];
                const keys = keysLabel(action);
                return (
                  <DropdownMenuItem
                    key={action}
                    disabled={disabled(action)}
                    onSelect={() => void run(action)}
                    title={ACTION_HINT[action]}
                  >
                    <Icon className="mr-2 h-3.5 w-3.5" />
                    {NEXT_ACTION_LABEL[action]}
                    {keys && <DropdownMenuShortcut>{keys}</DropdownMenuShortcut>}
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={copyBranch}>
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy branch name
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <ConfirmDialog
        open={confirm === 'merge' && pr !== null}
        title={pr ? `Merge #${pr.number}?` : 'Merge?'}
        description={
          pr ? (
            <>
              {pr.summary.title} merges into <span className="font-mono">{pr.summary.baseBranch}</span> on GitHub.
            </>
          ) : undefined
        }
        confirmLabel="Merge"
        busy={busy === 'merge'}
        onConfirm={() => void merge()}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        title={`Archive ${workbench.name}?`}
        description="The session moves to History. The branch, its chats and any PR stay, and you can restore it later."
        confirmLabel="Archive"
        busy={busy === 'archive'}
        onConfirm={() => void archive()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
