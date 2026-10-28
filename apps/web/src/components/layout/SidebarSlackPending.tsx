import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Slack } from 'lucide-react';
import type { SlackPendingRequest } from '@talyn/shared';
import { api } from '../../lib/api';
import { slackChannelLabel } from '../../lib/slackSession';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { useSlackPendingStore } from '../../stores/slackPending';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';

const TITLE_MAX = 80;

/** The first line of the built prompt, as a short title. */
export function pendingTitle(prompt: string): string {
  const line = prompt.split('\n').find((l) => l.trim()) ?? 'Slack request';
  const trimmed = line.trim();
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX - 1)}…` : trimmed;
}

/** "From Slack, waiting for a repository": one card per request, with a picker and Start. */
export function SidebarSlackPending() {
  const pending = useSlackPendingStore((s) => s.pending);
  if (pending.length === 0) return null;
  return (
    <div className="mb-2 space-y-1" data-attr="sidebar-slack-pending" role="group" aria-label="From Slack, waiting for a repository">
      <div className="flex items-center gap-1 px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">
        <Slack className="h-3 w-3" />
        From Slack, waiting for a repository
      </div>
      {pending.map((request) => (
        <PendingItem key={request.id} request={request} />
      ))}
    </div>
  );
}

function PendingItem({ request }: { request: SlackPendingRequest }) {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const focusId = useSlackPendingStore((s) => s.focusId);
  const navigate = useNavigationStore((s) => s.navigate);
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  const candidates = request.candidates;
  const others = useMemo(() => {
    const taken = new Set(candidates.map((c) => c.repositoryId));
    return repositories.filter((r) => r.workspaceId === request.workspaceId && !taken.has(r.id));
  }, [repositories, candidates, request.workspaceId]);
  const [repositoryId, setRepositoryId] = useState(candidates[0]?.repositoryId ?? '');

  const focused = focusId === request.id;
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView?.({ block: 'nearest' });
    ref.current?.querySelector('select')?.focus();
    useSlackPendingStore.getState().focus(null);
  }, [focused]);

  const start = async () => {
    if (!repositoryId || busy) return;
    setBusy(true);
    try {
      const workbench = await api.slack.startPending(request.id, { repositoryId });
      useWorkbenchStore.getState().upsertWorkbench(workbench);
      useSlackPendingStore.getState().remove(request.id);
      navigate({ view: 'workbench', id: workbench.id });
    } catch (err) {
      toast.error('Could not start the session', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      data-attr="slack-pending-item"
      className={cn('mx-1 space-y-1.5 rounded-md border bg-background/60 p-2', focused && 'ring-1 ring-primary')}
    >
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium" title={request.prompt}>
          {pendingTitle(request.prompt)}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {slackChannelLabel(request.source)}
          {request.source.teamName ? ` · ${request.source.teamName}` : ''}
        </div>
      </div>
      <select
        aria-label="Repository"
        value={repositoryId}
        onChange={(e) => setRepositoryId(e.target.value)}
        className="h-7 w-full rounded-md border bg-background px-2 text-xs"
      >
        {!repositoryId && <option value="">Choose a repository…</option>}
        {candidates.length > 0 && (
          <optgroup label="Closest matches">
            {candidates.map((c) => (
              <option key={c.repositoryId} value={c.repositoryId}>
                {c.repoFullName}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label={candidates.length > 0 ? 'All repositories' : 'Repositories'}>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <Button size="sm" className="h-7 w-full text-xs" disabled={!repositoryId || busy} onClick={() => void start()} data-attr="slack-pending-start">
        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        Start
      </Button>
    </div>
  );
}
