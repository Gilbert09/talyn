import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Moon, RefreshCw } from 'lucide-react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { api } from '../../lib/api';
import { useIsWorkbenchOwner } from '../../lib/spaces';
import { toast } from '../../stores/toast';
import { chatInsights } from '../../lib/workbenchFormat';
import { ensureChatHistory, loadOlderEvents, loadWorkbench } from '../../lib/workbenchData';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { emptyChatEvents, useWorkbenchStore } from '../../stores/workbenches';
import { maybeHandleBillingLimit, useBillingStore } from '../../stores/billing';
import { BoxRefusalAction, sessionRefusalText } from '../billing/BoxRefusalAction';
import { Button } from '../ui/button';
import { ChatTabs } from './ChatTabs';
import { Composer } from './Composer';
import { GitPanel } from './GitPanel';
import { WorkPanel } from './WorkPanel';
import { isThread } from '../../lib/threads';
import { WorkbenchHeader } from './WorkbenchHeader';
import { PRDetailSheet } from '../widgets/PRDetailSheet';
import { WorkbenchTranscript } from './WorkbenchTranscript';
import { trackEvent } from '../../lib/analytics';
import { captureWorkbenchFailure } from '../../lib/workbenchAnalytics';
import { isStarting, StartingHint } from './WorkbenchStarting';
import { useSelectedChat, useWorkbenchOps, useWorkbenchPr } from './workbenchSelectors';
import { useRepoPaths } from './new/useRepoPaths';
import { getDeviceId } from '../../lib/workbenchBridge';
import { checkoutFor, takeOverLocalWorkbench } from '../../lib/localTakeover';
import { useWorkbenchBackgroundLoad } from '../../hooks/useSessionBackground';
import { clientAttentionKey, useAttentionSeen } from '../../lib/contextRail';
import { sessionPr } from '../../lib/sessionState';
import { ImageDropOverlay, useImageDropZone } from './useComposerImages';

/** The header spans the chat and right panel. Threads use WorkPanel on the right. */
export function WorkbenchView({ workbench }: { workbench: Workbench }) {
  useWorkbenchBackgroundLoad(workbench.id);
  const ops = useWorkbenchOps(workbench);
  const repoPaths = useRepoPaths();
  const foreign = workbench.runtime === 'local' && Boolean(workbench.deviceId) && workbench.deviceId !== getDeviceId();
  const checkout = foreign ? checkoutFor(repoPaths.paths, workbench.repoFullName) : null;
  const reason = foreign && repoPaths.ready && !checkout
    ? `Choose the folder of your ${workbench.repoFullName} checkout to continue this session here.`
    : ops.unavailable;
  const viewOps = useMemo(() => reason === ops.unavailable ? ops : { ...ops, unavailable: reason }, [ops, reason]);
  const [choosing, setChoosing] = useState(false);
  const chat = useSelectedChat(workbench.id);
  const pr = useWorkbenchPr(workbench);
  const rightPanelOpen = useWorkbenchStore((s) => s.rightPanelOpen);
  const prDetailId = useWorkbenchStore((s) => s.prDetailId);
  const openPrDetail = useWorkbenchStore((s) => s.openPrDetail);
  const storeChats = useWorkbenchStore((s) => s.chats[workbench.id]);
  useAttentionSeen(
    workbench.id,
    clientAttentionKey(workbench, storeChats ?? workbench.chats ?? [], sessionPr(workbench, pr)),
  );

  // The overlay belongs to the session it was opened from.
  useEffect(() => () => openPrDetail(null), [workbench.id, openPrDetail]);

  // A fresh read on open: the list may be minutes old, and it carries the chats when the backend embeds them.
  // Opening never wakes the sandbox: only a prompt or a person's action does (the composer, the terminal, a refresh).
  useEffect(() => {
    void loadWorkbench(workbench.id);
  }, [workbench.id]);

  const chooseFolder = async () => {
    setChoosing(true);
    try {
      const chosen = await repoPaths.pickFolder(workbench.repoFullName);
      if (chosen) {
        await takeOverLocalWorkbench(workbench, chosen.path);
        trackEvent('session_moved', { workbench_id: workbench.id, reason: 'disk' });
      }
    } catch (error) {
      captureWorkbenchFailure('move_session', error, workbench.id);
      toast.error('Could not move the session', error instanceof Error ? error.message : undefined);
    } finally {
      setChoosing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-attr="workbench-view">
      <WorkbenchHeader workbench={workbench} pr={pr} chat={chat} ops={viewOps} />
      <div className="flex min-h-0 min-w-0 flex-1" data-attr="workbench-columns">
        <div className="flex min-w-0 flex-1 flex-col">
          <ChatTabs workbench={workbench} selected={chat} />
          {foreign && reason && (
            <Banner tone="muted" icon={<AlertTriangle className="h-3.5 w-3.5" />} text={reason}
              action={!checkout && repoPaths.ready ? (
                <Button variant="outline" className="h-6 px-2 text-xs" disabled={choosing} onClick={() => void chooseFolder()}>
                  Choose folder
                </Button>
              ) : undefined} />
          )}
          {!foreign && <StatusBanner workbench={workbench} ops={viewOps} />}
          <ChatView workbench={workbench} chat={chat} ops={viewOps} />
        </div>
        {rightPanelOpen &&
          (isThread(workbench) ? (
            <WorkPanel thread={workbench} />
          ) : (
            <GitPanel workbench={workbench} chat={chat} ops={viewOps} pr={pr} />
          ))}
      </div>
      <PRDetailSheet
        pullRequestId={prDetailId}
        onClose={() => openPrDetail(null)}
        layout="overlay"
        seedRow={pr && pr.id === prDetailId ? pr : null}
      />
    </div>
  );
}

function ChatView({ workbench, chat, ops }: { workbench: Workbench; chat: WorkbenchChat | null; ops: WorkbenchOps }) {
  const state = useWorkbenchStore((s) => (chat ? s.chatEvents[chat.id] : undefined)) ?? emptyChatEvents;
  const markRead = useWorkbenchStore((s) => s.markRead);

  useEffect(() => {
    if (chat) void ensureChatHistory(chat.id);
  }, [chat?.id]);

  // Looking at a chat reads it; so does coming back to the window while it is open.
  useEffect(() => {
    if (!chat) return undefined;
    markRead(chat.id);
    const onFocus = () => markRead(chat.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [chat?.id, chat?.status, markRead]);

  const insights = useMemo(() => chatInsights(state.events), [state.events]);
  const localQueue = useWorkbenchStore((s) => (chat ? s.localQueues[chat.id] : undefined));
  const queued = (ops.runtime === 'local' ? localQueue : chat?.queuedMessages)?.length ?? 0;
  const startingHint = isStarting(workbench) ? <StartingHint workbench={workbench} queued={queued} /> : undefined;
  // The whole chat column takes image drops, not only the composer strip.
  const attachRef = useRef<((files: File[]) => void) | null>(null);
  const { dragging, dropProps } = useImageDropZone((files) => attachRef.current?.(files));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-attr="workbench-chat-drop-zone" {...dropProps}>
      <ImageDropOverlay dragging={dragging} />
      <div className="min-h-0 flex-1">
        {chat ? (
          <WorkbenchTranscript
            chat={chat}
            events={state.events}
            loading={state.loading}
            error={state.error}
            ops={ops}
            canRetry={queued === 0 && workbench.status !== 'error' && workbench.sandboxState !== 'error'}
            emptyHint={startingHint}
            older={{
              hasOlder: state.hasOlder,
              loading: state.loadingOlder,
              error: state.olderError,
              load: () => loadOlderEvents(chat.id),
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-background px-6 text-center text-xs text-muted-foreground">
            {startingHint ?? 'No chat yet. Send a message to start one.'}
          </div>
        )}
      </div>
      <Composer workbench={workbench} chat={chat} ops={ops} todos={insights.todos} contextUsage={insights.contextUsage} slashCommands={insights.slashCommands} attachRef={attachRef} />
    </div>
  );
}

function StatusBanner({ workbench, ops }: { workbench: Workbench; ops: WorkbenchOps }) {
  const owner = useIsWorkbenchOwner(workbench);
  const setTerminalTab = useWorkbenchStore((s) => s.setTerminalTab);
  const hasSetupOutput = useWorkbenchStore((s) => (s.scriptOutput[workbench.id]?.setup?.total ?? 0) > 0);
  const refusal = useBillingStore((s) => s.sessionRefusals[workbench.id]);
  const [retrying, setRetrying] = useState(false);

  // Errors first: a failed start can still say sandboxState 'creating', and a spinner would hide it.
  if (workbench.status === 'error' || workbench.sandboxState === 'error') {
    const retry = async () => {
      setRetrying(true);
      try {
        useWorkbenchStore.getState().upsertWorkbench(await api.workbenches.retry(workbench.id));
        trackEvent('session_retry', { workbench_id: workbench.id });
      } catch (err) {
        captureWorkbenchFailure('retry_session', err, workbench.id);
        if (!maybeHandleBillingLimit(err, 'workbench_retry')) {
          toast.error('Could not retry', err instanceof Error ? err.message : undefined);
        }
      } finally {
        setRetrying(false);
      }
    };
    return (
      <Banner
        tone="error"
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
        text={workbench.error ?? workbench.statusMessage ?? 'The session hit an error. Retry, or delete it.'}
        action={
          <>
            {owner && workbench.runtime === 'sandbox' && (
              <Button variant="outline" className="h-6 gap-1 px-2 text-xs" disabled={retrying} onClick={() => void retry()}>
                {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Retry
              </Button>
            )}
            {owner && hasSetupOutput && (
              <Button variant="ghost" className="h-6 px-2 text-xs" onClick={() => setTerminalTab('setup')}>
                Show setup output
              </Button>
            )}
          </>
        }
      />
    );
  }
  if (ops.unavailable && workbench.status !== 'provisioning' && workbench.sandboxState !== 'lost') {
    return <Banner tone="muted" icon={<AlertTriangle className="h-3.5 w-3.5" />} text={ops.unavailable} />;
  }
  if (workbench.status === 'provisioning' || workbench.sandboxState === 'creating' || workbench.sandboxState === 'lost') {
    return (
      <Banner
        tone="muted"
        icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />}
        text={
          (workbench.sandboxState === 'lost' ? 'The sandbox was lost. Talyn is starting a new one.' : workbench.statusMessage) ||
          (isThread(workbench)
            ? 'Starting the sandbox…'
            : workbench.runtime === 'sandbox'
              ? 'Starting the sandbox and cloning the repository…'
              : 'Creating the worktree…')
        }
        action={
          owner && hasSetupOutput ? (
            <Button variant="ghost" className="h-6 px-2 text-xs" onClick={() => setTerminalTab('setup')}>
              Show setup output
            </Button>
          ) : undefined
        }
      />
    );
  }
  if (workbench.runtime === 'sandbox' && refusal) {
    return (
      <Banner
        tone="muted"
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
        text={sessionRefusalText(refusal)}
        action={<BoxRefusalAction code={refusal.status} notice={refusal.notice} />}
      />
    );
  }
  if (workbench.runtime === 'sandbox' && workbench.sandboxState === 'suspended') {
    return (
      <Banner
        tone="muted"
        icon={<Moon className="h-3.5 w-3.5" />}
        text="The sandbox is asleep to save resources. It wakes up by itself when you send a message."
      />
    );
  }
  return null;
}

function Banner({
  tone,
  icon,
  text,
  action,
}: {
  tone: 'muted' | 'error';
  icon: React.ReactNode;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={
        tone === 'error'
          ? 'flex items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive'
          : 'flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground'
      }
    >
      {icon}
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
}
