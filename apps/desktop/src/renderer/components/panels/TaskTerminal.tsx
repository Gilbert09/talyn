import React, { useCallback, useEffect, useState } from 'react';
import {
  Square,
  Loader2,
  MessageSquare,
  CheckCircle,
  AlertCircle,
  Play,
  Terminal,
  FileCheck,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { AgentConversation } from '../terminal/AgentConversation';
import { TaskComposer, EFFORTS_BY_MODEL, AUTO_MODEL } from './TaskComposer';
import { useTaskActions, mergeTaskTranscript } from '../../hooks/useApi';
import { useWorkspaceStore } from '../../stores/workspace';
import { api } from '../../lib/api';
import type { Task, AgentStatus, AgentAttention } from '@fastowl/shared';

interface TaskTerminalProps {
  task: Task;
}

const statusConfig: Record<
  AgentStatus,
  { icon: React.ElementType; label: string; color: string }
> = {
  idle: { icon: Terminal, label: 'Idle', color: 'text-slate-400' },
  working: { icon: Loader2, label: 'Working', color: 'text-blue-400' },
  awaiting_input: {
    icon: MessageSquare,
    label: 'Awaiting Input',
    color: 'text-yellow-400',
  },
  tool_use: { icon: Play, label: 'Running Tool', color: 'text-purple-400' },
  completed: { icon: CheckCircle, label: 'Completed', color: 'text-green-400' },
  error: { icon: AlertCircle, label: 'Error', color: 'text-red-400' },
};

const attentionColors: Record<AgentAttention, string> = {
  none: 'border-transparent',
  low: 'border-yellow-400/50',
  medium: 'border-orange-400',
  high: 'border-red-400',
};

export function TaskTerminal({ task }: TaskTerminalProps) {
  const { sendTaskInput, continueTask, stopTask, readyForReview } = useTaskActions();
  const environments = useWorkspaceStore((s) => s.environments);
  const updateTask = useWorkspaceStore((s) => s.updateTask);
  const [inputValue, setInputValue] = useState('');
  const [isStopping, setIsStopping] = useState(false);
  const [isMarkingReady, setIsMarkingReady] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const cloudMeta = task.metadata as { model?: string; reasoningEffort?: string } | undefined;
  // Default to Auto (let PostHog Code pick) unless the task was pinned to a model.
  const [model, setModel] = useState(cloudMeta?.model || AUTO_MODEL);
  const [effort, setEffort] = useState(cloudMeta?.reasoningEffort || 'high');

  const agentStatus = task.agentStatus || 'working';
  const agentAttention = task.agentAttention || 'none';
  const assignedEnv = environments.find((e) => e.id === task.assignedEnvironmentId);
  const envName = assignedEnv?.name;
  const isCloudTask = assignedEnv?.type === 'posthog_code';
  // Tasks whose child already exited (awaiting_review / completed /
  // failed) can still be resumed if we captured a `claudeSessionId`
  // on their metadata. The input bar routes Send to /continue in that
  // case, which spawns a fresh CLI child with `--resume <id>` + the
  // prompt.
  const claudeSessionId = (task.metadata as { claudeSessionId?: string } | undefined)
    ?.claudeSessionId;
  const isResumable =
    task.status !== 'in_progress' &&
    task.status !== 'cancelled' &&
    typeof claudeSessionId === 'string';

  const StatusIcon = statusConfig[agentStatus].icon;

  // PostHog Code tasks run in the cloud and their transcript is NOT included
  // in the task-list payload, so the store opens them with an empty
  // transcript. On open we (1) kick the backend to start/continue the log
  // stream and flush any buffered events, then (2) fetch the full task —
  // GET /:id is the only endpoint that returns `transcript` — and hydrate
  // the store. Live `task:event`s keep appending afterwards (deduped on
  // seq). Without this, an in-progress run shows only the placeholder until
  // it completes, because its events were broadcast before the user opened
  // it. Keyed on task id so it runs once per open.
  useEffect(() => {
    if (!isCloudTask) return;
    let cancelled = false;
    void (async () => {
      try {
        await api.tasks.refreshLogs(task.id);
        const full = await api.tasks.get(task.id);
        if (cancelled || !full.transcript?.length) return;
        mergeTaskTranscript(task.id, full.transcript);
      } catch {
        // Best-effort — the live stream still populates the transcript.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task.id, isCloudTask]);

  const handleSendInput = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isSending) return;
    setIsSending(true);
    try {
      if (isCloudTask) {
        // Cloud task — resume a finished run or inject into a live one.
        // Auto omits both model and effort so PostHog Code picks the model.
        const isAuto = model === AUTO_MODEL;
        await api.tasks.sendCloudMessage(task.id, {
          message: trimmed,
          model: isAuto ? undefined : model,
          reasoningEffort: isAuto ? undefined : effort,
        });
      } else if (task.status === 'in_progress') {
        await sendTaskInput(task.id, inputValue);
      } else if (isResumable) {
        await continueTask(task.id, inputValue);
      } else {
        return;
      }
      setInputValue('');
    } catch (err) {
      console.error('Failed to send input:', err);
      // Local state may be stale — backend might have transitioned
      // the task without a WS event reaching us (redeploy, dropped
      // socket, etc). Refetch so the input bar + buttons reflect
      // reality on the next render.
      api.tasks.get(task.id).then((fresh) => updateTask(task.id, fresh)).catch(() => {});
    } finally {
      setIsSending(false);
    }
  }, [
    task.id,
    task.status,
    inputValue,
    isSending,
    isCloudTask,
    model,
    effort,
    sendTaskInput,
    continueTask,
    isResumable,
    updateTask,
  ]);

  // Keep effort valid when the model changes (some models offer fewer levels).
  const handleModelChange = useCallback((next: string) => {
    setModel(next);
    setEffort((cur) => (EFFORTS_BY_MODEL[next]?.includes(cur) ? cur : 'high'));
  }, []);

  const handleStopTask = useCallback(async () => {
    setIsStopping(true);
    try {
      await stopTask(task.id);
    } catch (err) {
      console.error('Failed to stop task:', err);
    } finally {
      setIsStopping(false);
    }
  }, [task.id, stopTask]);

  const handleReadyForReview = useCallback(async () => {
    setIsMarkingReady(true);
    try {
      await readyForReview(task.id);
    } catch (err) {
      console.error('Failed to mark ready for review:', err);
    } finally {
      setIsMarkingReady(false);
    }
  }, [task.id, readyForReview]);

  // Composer enable/placeholder policy. Cloud tasks accept follow-ups in
  // any state once a run exists (resume finished runs / inject into live
  // ones); local tasks only accept input while in_progress or when an
  // ended session is resumable.
  let composerDisabled: boolean;
  let composerPlaceholder: string;
  if (isCloudTask) {
    const started = task.status !== 'pending' && task.status !== 'queued';
    composerDisabled = isSending || !started;
    composerPlaceholder = !started
      ? 'Task hasn’t started yet…'
      : task.status === 'in_progress'
        ? 'Message the running agent…'
        : 'Send a follow-up to continue this task…';
  } else {
    const ended = task.status !== 'in_progress';
    const busy = !ended && (agentStatus === 'working' || agentStatus === 'tool_use');
    composerDisabled = isSending || busy || (ended && !isResumable);
    composerPlaceholder = ended
      ? isResumable
        ? 'Continue the conversation…'
        : `Task is ${task.status} — no active session.`
      : busy
        ? 'Claude is working…'
        : agentStatus === 'awaiting_input'
          ? 'Type your response…'
          : 'Send a message to Claude…';
  }

  return (
    <div
      className={cn(
        'flex flex-col h-full min-w-0 border-l-4',
        attentionColors[agentAttention]
      )}
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between p-3 border-b bg-card">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'w-3 h-3 rounded-full',
              agentStatus === 'working' && 'bg-blue-400 animate-pulse',
              agentStatus === 'idle' && 'bg-slate-400',
              agentStatus === 'awaiting_input' && 'bg-yellow-400',
              agentStatus === 'error' && 'bg-red-400',
              agentStatus === 'completed' && 'bg-green-400',
              agentStatus === 'tool_use' && 'bg-purple-400'
            )}
          />
          <span className="font-medium text-sm">Task Terminal</span>
          <Badge variant="outline" className="text-xs">
            <StatusIcon
              className={cn(
                'w-3 h-3 mr-1',
                agentStatus === 'working' && 'animate-spin'
              )}
            />
            {statusConfig[agentStatus].label}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {/*
            Header actions only make sense while the child is actually
            alive (task.status === 'in_progress'). Once the child exits,
            the task has already transitioned to `awaiting_review` (or
            `failed` / `cancelled`) — "Stop" has nothing to stop and
            "Ready for Review" is idempotent. Hide them to avoid the
            400 the user reported.
          */}
          {task.status === 'in_progress' && (
            <>
              <Button
                variant="default"
                size="sm"
                className="h-8"
                title="End the session and move this task to Awaiting Review — transcript + any branch changes preserved for you to approve."
                onClick={handleReadyForReview}
                disabled={isMarkingReady || isStopping}
              >
                {isMarkingReady ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <FileCheck className="w-4 h-4 mr-1" />
                )}
                Finish
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-destructive hover:text-destructive"
                title="Abort the session and mark the task Failed. Use when the agent went off-track."
                onClick={handleStopTask}
                disabled={isStopping || isMarkingReady}
              >
                {isStopping ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Square className="w-4 h-4 mr-1" />
                )}
                Abort
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 bg-[#1e1e1e] overflow-hidden">
        <AgentConversation
          taskId={task.id}
          transcript={task.transcript}
          envName={envName}
          waitingHint={isCloudTask ? 'Running on PostHog Code — fetching logs…' : undefined}
          interactive
        />
      </div>

      {/* Composer — message the agent (live), continue a finished local
          session, or send a follow-up to a PostHog Code cloud task. */}
      <TaskComposer
        value={inputValue}
        onChange={setInputValue}
        onSend={handleSendInput}
        sending={isSending}
        disabled={composerDisabled}
        placeholder={composerPlaceholder}
        attention={!isCloudTask && agentStatus === 'awaiting_input'}
        autoFocus={!isCloudTask && agentStatus === 'awaiting_input'}
        showModelControls={isCloudTask}
        model={model}
        onModelChange={handleModelChange}
        effort={effort}
        onEffortChange={setEffort}
      />
    </div>
  );
}

