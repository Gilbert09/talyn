import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  Columns2,
  Copy,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  ListChecks,
  Loader2,
  MessagesSquare,
  PanelBottom,
  PanelRight,
  RotateCcw,
  RefreshCw,
  Cloud,
  Wrench,
} from 'lucide-react';
import { CREATE_PR_MESSAGE, splitViewOffered, workbenchDisplayName, type Workbench, type WorkbenchChat } from '@talyn/shared';
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
import { api, type PRChecks, type PRRow } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { captureWorkbenchFailure } from '../../lib/workbenchAnalytics';
import { openExternal } from '../../lib/openExternal';
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
import type { WorkbenchOps, WorkbenchPromptActionKind } from '../../lib/workbenchOps';
import { PRStatusPill } from '../widgets/PRStatusPill';
import { PrPill } from './WorkbenchBadges';
import { ArchiveWorkbenchDialog, archiveWorkbench } from './archiveWorkbench';
import { createChatTab } from './ChatTabs';
import { SlackThreadChip } from './SlackThreadChip';
import { slackSourceOf } from '../../lib/slackSession';
import { LinkPullRequestDialog } from './LinkPullRequestDialog';
import { SandboxStatusChip } from './SandboxStatusPanel';
import { SessionPreviewLinks } from './SessionPreviewLinks';
import { timeAgo } from './new/RecentWorkbenches';
import { RelativeTime } from '../RelativeTime';
import { newestEventAt } from '../../lib/relativeTime';
import { ThreadChip } from '../threads/ThreadChip';
import { isThread } from '../../lib/threads';
import { continueAsThread } from '../../lib/threadActions';
import { maybeHandleBillingLimit } from '../../stores/billing';
import { useRenameSession } from './useRenameSession';
import { SessionOwnerChip, SessionPresence, SessionSpaceChip, useSessionViewer } from '../spaces/SessionViewer';
import { spacesOffered } from '../../lib/spaces';
import { useSpacesStore } from '../../stores/spaces';
import { useWorkspaceStore } from '../../stores/workspace';
import { moveToSpace } from '../spaces/MoveToSpace';
import { useGitHubActions } from '../panels/github/useGitHubActions';
import { openInSplitView } from '../../lib/splitView';

const NO_CHECKS: PRChecks = {
  total: 0,
  passed: 0,
  failed: 0,
  inProgress: 0,
  skipped: 0,
};

const ACTION_ICON: Record<WorkbenchAction, typeof GitPullRequest> = {
  create_pr: GitPullRequest,
  resolve_conflicts: GitBranch,
  fix_checks: Wrench,
  merge: GitMerge,
  archive: Archive,
};

const ACTION_HINT: Record<WorkbenchAction, string> = {
  create_pr: 'Ask the agent to write the pull request; Talyn then commits, pushes and opens it',
  resolve_conflicts: 'Ask the agent to merge the base branch in and resolve the conflicts',
  fix_checks: 'Ask the agent to fix the failing checks; the prompt carries each failing check and its link',
  merge: 'Merge the pull request on GitHub',
  archive: 'Archive this session',
};

/** Send a prompt action to the sandbox agent. */
export async function runPromptAction(
  ops: WorkbenchOps,
  action: WorkbenchPromptActionKind,
  chat: WorkbenchChat | null,
  workbenchId?: string,
): Promise<void> {
  try {
    await ops.runAction(action, chat);
    if (action === 'fix_checks' || action === 'resolve_conflicts' || action === 'address_review') {
      trackEvent('session_fix_sent', { workbench_id: workbenchId, action });
    }
    toast.info(`${NEXT_ACTION_LABEL[action]}: sent to the agent`);
  } catch (err) {
    captureWorkbenchFailure('send_fix', err, workbenchId);
    toast.error(`Could not ${NEXT_ACTION_LABEL[action].toLowerCase()}`, err instanceof Error ? err.message : undefined);
  }
}

/**
 * Create PR: send "Create a pull request" to the chat, opening one when there
 * is none. The agent gets Talyn's PR instructions out of sight, and the end of
 * its turn opens the PR. A running turn queues it like any message.
 */
export async function sendCreatePullRequest(
  workbench: Workbench,
  ops: Pick<WorkbenchOps, 'send'>,
  chat: WorkbenchChat | null,
): Promise<void> {
  try {
    const target = chat ?? (await createChatTab(workbench));
    if (!target) return;
    const res = await ops.send(target, {
      text: CREATE_PR_MESSAGE,
      intent: 'create_pr',
      planMode: false,
    });
    trackEvent('session_message_sent', { queued: res.queued, plan_mode: false, model_id: target.model, attachments_count: 0 });
    if (res.queued && workbench.status !== 'moving') {
      toast.info(
        'Queued',
        (workbench.status === 'provisioning')
          ? 'It runs when the sandbox is ready.'
          : 'It runs when the current turn ends.',
      );
    }
  } catch (err) {
    captureWorkbenchFailure('create_pull_request', err, workbench.id);
    if (maybeHandleBillingLimit(err, 'session_create_pr')) return;
    toast.error('Could not create the pull request', err instanceof Error ? err.message : undefined);
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
  const setSideTab = useWorkbenchStore((s) => s.setSideTab);
  const openPrTab = () => setSideTab('pr');
  const openPrDetail = useWorkbenchStore((s) => s.openPrDetail);
  const rightPanelOpen = useWorkbenchStore((s) => s.rightPanelOpen);
  const splitOn = useWorkspaceStore((s) => splitViewOffered(s.features));
  // The session's newest stored event across the chats this client holds.
  const lastMessageAt = useWorkbenchStore((s) => {
    let newest: string | null = null;
    for (const id of [chat?.id, ...(workbench.chats ?? []).map((c) => c.id)]) {
      const at = id ? newestEventAt(s.chatEvents[id]?.events) : null;
      if (at && (!newest || at > newest)) newest = at;
    }
    return newest;
  });
  const { setMergeQueue } = useGitHubActions();
  const [queueBusy, setQueueBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [busy, setBusy] = useState<WorkbenchAction | null>(null);
  const [confirm, setConfirm] = useState<'merge' | 'archive' | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const rename = useRenameSession(workbench);
  const thread = isThread(workbench);
  const viewer = useSessionViewer(workbench);
  const owner = viewer.owner;
  const spacesOn = useWorkspaceStore((s) => spacesOffered(s.features));
  const continueInThread = async () => {
    setContinuing(true);
    try {
      await continueAsThread(workbench);
    } catch (err) {
      captureWorkbenchFailure('continue_as_thread', err, workbench.id);
      toast.error('Could not continue as a thread', err instanceof Error ? err.message : undefined);
    } finally {
      setContinuing(false);
    }
  };
  const unlink = async () => {
    setLinkBusy(true);
    try {
      useWorkbenchStore.getState().upsertWorkbench(await api.workbenches.unlinkPullRequest(workbench.id));
    } catch (err) {
      captureWorkbenchFailure('unlink_pull_request', err, workbench.id);
      toast.error('Could not unlink the pull request', err instanceof Error ? err.message : undefined);
    } finally {
      setLinkBusy(false);
    }
  };
  const prLike = pr ? prRowAsLike(pr) : null;
  const primary = primaryWorkbenchAction(workbench, prLike);
  const available = availableWorkbenchActions(workbench, prLike);
  const archived = isArchivedWorkbench(workbench);

  const canQueue = owner && !archived && !thread && pr?.state === 'open';
  const queueActionLabel = pr?.mergeQueued ? 'Remove from merge queue' : 'Add to merge queue';
  const toggleQueue = async () => {
    if (!canQueue || !pr || queueBusy) return;
    setQueueBusy(true);
    try {
      await setMergeQueue(pr, !pr.mergeQueued);
    } finally {
      setQueueBusy(false);
    }
  };

  const canRestart = !thread && workbench.runtime === 'sandbox' && workbench.status === 'ready' && !!workbench.sandboxId;
  const restartSandbox = async () => {
    setRestarting(true);
    try {
      const res = await api.workbenches.restart(workbench.id);
      trackEvent('session_moved', { workbench_id: workbench.id, reason: 'restart' });
      toast.info(
        res.outcome === 'restarting'
          ? 'Restarting the sandbox'
          : 'The sandbox restarts when the current turn ends',
        "The new sandbox gets the workspace's current MCP servers.",
      );
      setRestartOpen(false);
    } catch (err) {
      captureWorkbenchFailure('sandbox_restart', err, workbench.id);
      toast.error('Could not restart the sandbox', err instanceof Error ? err.message : undefined);
    } finally {
      setRestarting(false);
    }
  };

  const restore = async () => {
    setRestoring(true);
    try {
      const restored = await api.workbenches.restore(workbench.id);
      useWorkbenchStore.getState().upsertWorkbench(restored);
      trackEvent('session_restored', { workbench_id: workbench.id, kind: restored.kind ?? 'session', runtime: restored.runtime });
    } catch (err) {
      captureWorkbenchFailure('restore_session', err, workbench.id);
      if (maybeHandleBillingLimit(err, 'session_restore')) return;
      toast.error('Could not restore the session', err instanceof Error ? err.message : undefined);
    } finally {
      setRestoring(false);
    }
  };

  const disabled = (action: WorkbenchAction) =>
    busy !== null || queueBusy ||
    ((PROMPT_ACTIONS.has(action) || action === 'create_pr') && Boolean(ops.unavailable)) ||
    (action === 'merge' && !pr);

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
      if (action === 'create_pr') await sendCreatePullRequest(workbench, ops, chat);
      else await runPromptAction(ops, action, chat, workbench.id);
      setBusy(null);
    },
    [workbench, ops, chat],
  );

  // Shortcuts and the palette ask through an event, so they get the same
  // confirmations and busy state as a click.
  const latest = useRef({
    available,
    run,
    disabled,
    workbenchId: workbench.id,
    owner,
  });
  latest.current = { available, run, disabled, workbenchId: workbench.id, owner };
  useEffect(() => {
    const onRequest = (e: Event) => {
      const { workbenchId, action } = (e as CustomEvent<WorkbenchActionRequest>).detail ?? {};
      const cur = latest.current;
      if (workbenchId !== cur.workbenchId || !action || !cur.owner) return;
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
      captureWorkbenchFailure('merge_pull_request', err, workbench.id);
      toast.error(`Could not merge #${pr.number}`, err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    setBusy('archive');
    if (await archiveWorkbench(workbench.id, true)) setConfirm(null);
    setBusy(null);
  };

  const PrimaryIcon = primary ? ACTION_ICON[primary] : null;
  const primaryKeys = primary ? keysLabel(primary) : null;
  const mergedAgo = pr?.mergedAt ? timeAgo(pr.mergedAt) : null;

  return (
    <div className="min-w-0 border-b px-3 py-1.5" data-attr="workbench-header">
      <div
        className="flex min-w-0 items-center gap-2"
        data-attr="workbench-header-title-row"
      >
        {rename.editing ? rename.input : (
          <h1
            className="min-w-0 flex-1 truncate text-sm font-semibold"
            onDoubleClick={owner ? rename.start : undefined}
            title={owner ? 'Double-click to rename' : undefined}
          >
            {workbenchDisplayName(workbench)}
          </h1>
        )}
        <SessionSpaceChip spaceId={workbench.spaceId} />
        {!owner && <SessionOwnerChip creator={viewer.creator} />}
        <SessionPresence viewers={viewer.viewers} />
        <div className="flex min-w-0 max-w-[70%] shrink items-center gap-2">
          {!thread && pr?.state === "open" && pr.summary.url && (
            <div className="flex min-w-0 items-center gap-0.5">
              <Button
                variant="outline"
                className="h-7 min-w-0 max-w-24 gap-1.5 truncate px-2.5 text-xs"
                onClick={() => openPrDetail(pr.id)}
                title={`Open the details of #${pr.number}: ${pr.summary.title}`}
                data-attr="workbench-open-pr"
              >
                <GitPullRequest className="h-3.5 w-3.5" />
                PR #{pr.number}
              </Button>
              <Button
                variant="ghost"
                className="h-7 w-7 shrink-0 p-0"
                onClick={() => void openExternal(pr.summary.url)}
                title={`Open #${pr.number} on GitHub`}
                aria-label={`Open #${pr.number} on GitHub`}
                data-attr="workbench-open-pr-github"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {archived && owner && (
            <Button
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={() => void restore()}
              disabled={restoring}
            >
              {restoring ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Restore
            </Button>
          )}
          {canQueue && (
            <Button
              variant={pr?.mergeQueued ? 'secondary' : 'default'}
              className="h-7 min-w-0 gap-1.5 px-2.5 text-xs"
              onClick={() => void toggleQueue()}
              disabled={queueBusy || busy !== null}
              title={queueActionLabel}
              aria-label={queueActionLabel}
              data-attr="workbench-merge-queue"
            >
              {queueBusy ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <ListChecks className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{pr?.mergeQueued ? 'Queued' : queueActionLabel}</span>
            </Button>
          )}
          {!archived && owner && (
            <div className="flex min-w-0 items-center">
              {primary && PrimaryIcon && (
                <Button
                  className={cn(
                    "h-7 min-w-0 max-w-36 gap-1.5 overflow-hidden rounded-r-none px-2.5 text-xs",
                    primary === "archive" &&
                      "bg-muted text-foreground hover:bg-muted/80",
                  )}
                  onClick={() => void run(primary)}
                  disabled={disabled(primary)}
                  title={`${ACTION_HINT[primary]}${primaryKeys ? ` (${primaryKeys})` : ""}`}
                  data-testid="workbench-primary-action"
                >
                  {busy === primary ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PrimaryIcon className="h-3.5 w-3.5" />
                  )}
                  {primary === "archive" && pr?.state === "merged"
                    ? "Archive session"
                    : NEXT_ACTION_LABEL[primary]}
                  {primaryKeys && (
                    <span className="ml-0.5 hidden text-[10px] opacity-70 lg:inline">
                      {primaryKeys}
                    </span>
                  )}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant={primary ? "default" : "outline"}
                    className={cn(
                      "h-7 px-1.5 text-xs",
                      primary
                        ? "rounded-l-none border-l border-primary-foreground/20"
                        : "gap-1 px-2",
                      primary === "archive" &&
                        "bg-muted text-foreground hover:bg-muted/80",
                    )}
                    aria-label="More actions"
                    disabled={busy !== null || queueBusy}
                  >
                    {!primary && "Actions"}
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[13rem]">
                  <DropdownMenuItem onSelect={() => setTimeout(rename.start, 0)}>Rename session</DropdownMenuItem>
                  {canQueue && (
                    <DropdownMenuItem
                      disabled={queueBusy || busy !== null}
                      onSelect={() => void toggleQueue()}
                    >
                      <ListChecks className="mr-2 h-3.5 w-3.5" />
                      {queueActionLabel}
                    </DropdownMenuItem>
                  )}
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
                        {keys && (
                          <DropdownMenuShortcut>{keys}</DropdownMenuShortcut>
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                  {!thread && (
                    <>
                      <DropdownMenuSeparator />
                      {workbench.runtime === 'sandbox' && (
                        <DropdownMenuItem onSelect={() => setSideTab('sandbox')} data-attr="workbench-show-sandbox">
                          <Cloud className="mr-2 h-3.5 w-3.5" />
                          Sandbox
                        </DropdownMenuItem>
                      )}
                      {canRestart && (
                        <DropdownMenuItem
                          disabled={restarting}
                          onSelect={() => setRestartOpen(true)}
                          title="Move this session to a fresh sandbox, for example to load MCP servers connected after it started."
                          data-attr="workbench-restart-sandbox"
                        >
                          <RefreshCw className="mr-2 h-3.5 w-3.5" />
                          Restart sandbox
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        disabled={linkBusy}
                        onSelect={() =>
                          workbench.pullRequestId
                            ? void unlink()
                            : setLinkOpen(true)
                        }
                      >
                        <GitPullRequest className="mr-2 h-3.5 w-3.5" />
                        {workbench.pullRequestId
                          ? "Unlink pull request"
                          : "Link pull request…"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={copyBranch}>
                        <Copy className="mr-2 h-3.5 w-3.5" />
                        Copy branch name
                      </DropdownMenuItem>
                      {!workbench.threadId && (
                        <DropdownMenuItem
                          disabled={continuing}
                          onSelect={() => void continueInThread()}
                          data-attr="workbench-continue-as-thread"
                        >
                          <MessagesSquare className="mr-2 h-3.5 w-3.5" />
                          Continue as thread
                        </DropdownMenuItem>
                      )}
                      {spacesOn && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            data-attr="workbench-move-to-space"
                            onSelect={() =>
                              useSpacesStore.getState().openDialog({
                                kind: 'move',
                                target: 'session',
                                id: workbench.id,
                                spaceId: workbench.spaceId ?? null,
                              })
                            }
                          >
                            Move to space…
                          </DropdownMenuItem>
                          {workbench.spaceId && (
                            <DropdownMenuItem
                              onSelect={() => void moveToSpace('session', workbench.id, workbench.spaceId ?? null, null)}
                            >
                              Move to Personal
                            </DropdownMenuItem>
                          )}
                        </>
                      )}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {splitOn && (
            <Button
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => openInSplitView(workbench.id, 'session_header')}
              title="Open in split view"
              aria-label="Open in split view"
              data-attr="workbench-open-split-view"
            >
              <Columns2 className="h-4 w-4" />
            </Button>
          )}
          {!thread && owner && (
            <Button
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={toggleTerminal}
              title={`Toggle the terminal (${formatKeys("mod+j")})`}
              aria-label="Toggle the terminal"
            >
              <PanelBottom className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            className={cn(
              "h-7 w-7 p-0",
              !rightPanelOpen && "text-muted-foreground",
            )}
            onClick={toggleRightPanel}
            title={`${rightPanelOpen ? "Hide" : "Show"} the right panel (${formatKeys("mod+alt+b")})`}
            aria-label="Toggle the right panel"
            aria-pressed={rightPanelOpen}
          >
            <PanelRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        className="mt-1 flex min-w-0 items-center gap-2"
        data-attr="workbench-header-meta-row"
      >
        <div className="min-w-0 flex-[0_1_auto]">
          {!thread && pr?.state === "merged" && (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-0 rounded bg-merged/15 px-1.5 py-0.5 font-medium text-merged">
                Merged
              </span>
              <span className="truncate">
                PR #{pr.number} merged into{" "}
                {pr.summary.baseBranch || workbench.baseBranch}
              </span>
              {mergedAgo && (
                <span className="shrink-0">
                  · {mergedAgo === "now" ? "just now" : `${mergedAgo} ago`}
                </span>
              )}
            </div>
          )}
          {!thread && pr?.state === "closed" && (
            <div className="text-xs text-muted-foreground">
              PR #{pr.number} was closed without merging
            </div>
          )}
          {!thread && (
            <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden font-mono text-xs text-muted-foreground">
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
                {copied ? (
                  <Check className="h-3 w-3 text-success" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            </div>
          )}
        </div>
        <div className="ml-auto flex min-w-0 flex-[0_100_auto] items-center gap-1.5">
          {lastMessageAt && (
            <RelativeTime
              iso={lastMessageAt}
              prefix="Last message"
              className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground"
            />
          )}
          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&>*]:max-w-32 [&>*]:truncate"
            data-attr="workbench-header-chips"
          >
            {thread && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                data-attr="workbench-thread-badge"
              >
                <MessagesSquare className="h-3 w-3" />
                Thread
              </span>
            )}
            {workbench.runtime === "local" ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                title="Local session"
              >
                Local
              </span>
            ) : (
              <SandboxStatusChip workbench={workbench} chat={chat} />
            )}
            {!thread && workbench.threadId && (
              <ThreadChip threadId={workbench.threadId} />
            )}
            {slackSourceOf(workbench) && (
              <SlackThreadChip source={slackSourceOf(workbench)!} />
            )}
            {!thread && <SessionPreviewLinks workbench={workbench} ops={ops} />}
            {workbench.settings?.internetAccess === false && (
              <span
                className="shrink-0 text-[10px] text-muted-foreground"
                title="This sandbox has limited network access"
              >
                No internet
              </span>
            )}
            {!thread && pr?.state === "open" && (
              <PRStatusPill
                compact
                blockingReason={pr.summary.blockingReason}
                checks={pr.summary.checks ?? NO_CHECKS}
                mergeStateStatus={pr.summary.mergeStateStatus}
                state={pr.state}
                hideReviewState
                labels={pr.summary.labels}
                ciStatus={pr.summary.ciStatus}
                humanGates={pr.summary.humanGates}
                onClick={openPrTab}
                className="shrink-0"
              />
            )}
            {!thread && pr && pr.state !== "open" && (
              <button
                type="button"
                onClick={openPrTab}
                title={`${pr.summary.title}. Show the pull request`}
                className="app-region-no-drag"
              >
                <PrPill
                  number={pr.number}
                  state={pr.state}
                  draft={pr.summary.draft}
                />
              </button>
            )}
          </div>
        </div>
      </div>
      {linkOpen && <LinkPullRequestDialog workbench={workbench} onClose={() => setLinkOpen(false)} />}
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
        initialFocus="confirm"
        busy={busy === 'merge'}
        onConfirm={() => void merge()}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={restartOpen}
        title="Restart the sandbox?"
        description="Talyn moves this session to a fresh sandbox with the workspace's current MCP servers. Files, branches, uncommitted changes and the conversation carry over. Running scripts and terminals stop. A running turn finishes first."
        confirmLabel="Restart"
        initialFocus="confirm"
        busy={restarting}
        onConfirm={() => void restartSandbox()}
        onCancel={() => setRestartOpen(false)}
      />
      <ArchiveWorkbenchDialog
        workbench={workbench}
        open={confirm === 'archive'}
        busy={busy === 'archive'}
        onConfirm={() => void archive()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
