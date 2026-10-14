import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Moon, RefreshCw } from 'lucide-react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { chatInsights } from '../../lib/workbenchFormat';
import { ensureChatHistory, loadWorkbench } from '../../lib/workbenchData';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { emptyChatEvents, useWorkbenchStore } from '../../stores/workbenches';
import { Button } from '../ui/button';
import { ChatTabs } from './ChatTabs';
import { Composer } from './Composer';
import { WorkbenchHeader } from './WorkbenchHeader';
import { WorkbenchSidePanel } from './WorkbenchSidePanel';
import { WorkbenchTranscript } from './WorkbenchTranscript';
import { TerminalPanel } from './terminal/TerminalPanel';
import { useSelectedChat, useWorkbenchOps, useWorkbenchPr } from './workbenchSelectors';

/** One workbench: header, chat tabs + transcript + composer, the side panel and the terminal. */
export function WorkbenchView({ workbench }: { workbench: Workbench }) {
  const ops = useWorkbenchOps(workbench);
  const chat = useSelectedChat(workbench.id);
  const pr = useWorkbenchPr(workbench);
  const terminalOpen = useWorkbenchStore((s) => s.terminalOpen);

  // A fresh read on open: the list may be minutes old, and it carries the chats when the backend embeds them.
  useEffect(() => {
    void loadWorkbench(workbench.id);
  }, [workbench.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkbenchHeader workbench={workbench} pr={pr} chat={chat} ops={ops} />
      <StatusBanner workbench={workbench} ops={ops} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <ChatTabs workbench={workbench} selected={chat} />
          <ChatView workbench={workbench} chat={chat} ops={ops} />
        </div>
        <WorkbenchSidePanel workbench={workbench} chat={chat} ops={ops} pr={pr} />
      </div>
      {terminalOpen && <TerminalPanel workbench={workbench} ops={ops} />}
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

  return (
    <>
      <div className="min-h-0 flex-1">
        {chat ? (
          <WorkbenchTranscript chat={chat} events={state.events} loading={state.loading} error={state.error} ops={ops} />
        ) : (
          <div className="flex h-full items-center justify-center bg-background px-6 text-center text-xs text-muted-foreground">
            {workbench.status === 'provisioning'
              ? 'The workbench is getting ready. You can write the first message now.'
              : 'No chat yet. Send a message to start one.'}
          </div>
        )}
      </div>
      <Composer workbench={workbench} chat={chat} ops={ops} todos={insights.todos} contextUsage={insights.contextUsage} />
    </>
  );
}

function StatusBanner({ workbench, ops }: { workbench: Workbench; ops: WorkbenchOps }) {
  const setTerminalTab = useWorkbenchStore((s) => s.setTerminalTab);
  const hasSetupOutput = useWorkbenchStore((s) => (s.scriptOutput[workbench.id]?.setup?.total ?? 0) > 0);
  const [retrying, setRetrying] = useState(false);

  // Errors first: a failed start can still say sandboxState 'creating', and a spinner would hide it.
  if (workbench.status === 'error' || workbench.sandboxState === 'error') {
    const retry = async () => {
      setRetrying(true);
      try {
        useWorkbenchStore.getState().upsertWorkbench(await api.workbenches.retry(workbench.id));
      } catch (err) {
        toast.error('Could not retry', err instanceof Error ? err.message : undefined);
      } finally {
        setRetrying(false);
      }
    };
    return (
      <Banner
        tone="error"
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
        text={workbench.error ?? workbench.statusMessage ?? 'The workbench hit an error. Retry, or delete it.'}
        action={
          <>
            {workbench.runtime === 'sandbox' && (
              <Button variant="outline" className="h-6 gap-1 px-2 text-xs" disabled={retrying} onClick={() => void retry()}>
                {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Retry
              </Button>
            )}
            {hasSetupOutput && (
              <Button variant="ghost" className="h-6 px-2 text-xs" onClick={() => setTerminalTab('setup')}>
                Show setup output
              </Button>
            )}
          </>
        }
      />
    );
  }
  if (ops.unavailable && workbench.status !== 'provisioning') {
    return <Banner tone="muted" icon={<AlertTriangle className="h-3.5 w-3.5" />} text={ops.unavailable} />;
  }
  if (workbench.status === 'provisioning' || workbench.sandboxState === 'creating') {
    return (
      <Banner
        tone="muted"
        icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />}
        text={
          workbench.statusMessage ||
          (workbench.runtime === 'sandbox' ? 'Starting the sandbox and cloning the repository…' : 'Creating the worktree…')
        }
        action={
          hasSetupOutput ? (
            <Button variant="ghost" className="h-6 px-2 text-xs" onClick={() => setTerminalTab('setup')}>
              Show setup output
            </Button>
          ) : undefined
        }
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
          ? 'flex items-center gap-2 border-b bg-red-500/10 px-4 py-1.5 text-xs text-red-700 dark:text-red-300'
          : 'flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground'
      }
    >
      {icon}
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
}
