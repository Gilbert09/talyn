import React, { useCallback, useEffect, useState } from 'react';
import {
  Square,
  Loader2,
  MessageSquare,
  CheckCircle,
  AlertCircle,
  Play,
  Terminal,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { AgentConversation } from '../terminal/AgentConversation';
import { useTaskActions, mergeTaskTranscript } from '../../hooks/useApi';
import { useOnReconnect } from '../../hooks/useOnReconnect';
import { useWorkspaceStore } from '../../stores/workspace';
import { api } from '../../lib/api';
import { readCloudTaskMeta } from '@fastowl/shared';
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
  const { stopTask } = useTaskActions();
  const environments = useWorkspaceStore((s) => s.environments);
  const [isStopping, setIsStopping] = useState(false);

  const agentStatus = task.agentStatus || 'working';
  const agentAttention = task.agentAttention || 'none';
  const assignedEnv = environments.find((e) => e.id === task.assignedEnvironmentId);
  const envName = assignedEnv?.name;
  // The task carries a remote cloud run (provider-neutral; covers legacy
  // posthog* metadata too). Null until dispatch stamps the remote ids.
  const cloudMeta = readCloudTaskMeta(task);

  const StatusIcon = statusConfig[agentStatus].icon;

  // Cloud tasks run remotely and their transcript is NOT included in the
  // task-list payload, so the store opens them with an empty transcript.
  // Hydration (1) kicks the backend to start/continue the log stream and
  // flush any buffered events, then (2) fetches the full task —
  // GET /:id is the only endpoint that returns `transcript` — and merges it
  // into the store. Live `task:event`s keep appending afterwards (deduped on
  // seq, so re-running this is idempotent). Merging is keyed by task id into
  // the global store, so a fetch landing after a task switch is still useful.
  const hasCloudRun = Boolean(cloudMeta?.remoteTaskId);
  const hydrateTranscript = useCallback(async () => {
    if (!hasCloudRun) return;
    try {
      await api.tasks.refreshLogs(task.id);
      const full = await api.tasks.get(task.id);
      if (full.transcript?.length) mergeTaskTranscript(task.id, full.transcript);
    } catch {
      // Best-effort — the live stream still populates the transcript.
    }
  }, [task.id, hasCloudRun]);

  // Once per open: without this, an in-progress run shows only the
  // placeholder until it completes, because its events were broadcast
  // before the user opened it.
  useEffect(() => {
    void hydrateTranscript();
  }, [hydrateTranscript]);

  // And again on a genuine reconnect: `task:event`s broadcast while the
  // socket was down are gone, and the task-list reconcile can't restore
  // them (the list payload drops `transcript` for egress).
  useOnReconnect(() => void hydrateTranscript());

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
          {/* Abort only makes sense while the cloud run is alive
              (task.status === 'in_progress'); afterwards the task is
              already terminal and /stop would 400. */}
          {task.status === 'in_progress' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-destructive hover:text-destructive"
              title="Cancel the cloud run and mark the task Cancelled. Use when the agent went off-track."
              onClick={handleStopTask}
              disabled={isStopping}
            >
              {isStopping ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Square className="w-4 h-4 mr-1" />
              )}
              Abort
            </Button>
          )}
        </div>
      </div>

      {/* Terminal Content — read-only transcript. Users no longer message
          cloud agents directly (cloud-only PR-management direction). */}
      <div className="flex-1 bg-[#1e1e1e] overflow-hidden">
        <AgentConversation
          taskId={task.id}
          transcript={task.transcript}
          envName={envName}
          waitingHint={hasCloudRun ? 'Running in the cloud — fetching logs…' : undefined}
          interactive
        />
      </div>
    </div>
  );
}
