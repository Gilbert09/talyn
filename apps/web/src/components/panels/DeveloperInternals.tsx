// Settings → Developer: the signed-in account's OWN internals. GitHub rate
// limits, Talyn Fleet agent state, and recent backend activity for this
// account. The cross-account Debug panel is on the operator console.
//
// This tab polls REST. It has no WebSocket stream.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import {
  fleetAgentLabel,
  type DeveloperActivity,
  type DeveloperActivityCategory,
  type DeveloperActivityEvent,
  type DeveloperAgent,
  type DeveloperRateLimitBucket,
  type DeveloperRateLimits,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Progress } from '../ui/progress';

/** Matches the backend's 10-second cache of the GitHub answer. */
export const DEVELOPER_POLL_MS = 10_000;

/** Below this share of a bucket, the card warns. */
const LOW_REMAINING = 0.1;

type Chip = 'all' | DeveloperActivityCategory;

const CHIPS: { id: Chip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'http', label: 'Requests' },
  { id: 'webhook', label: 'Webhooks' },
  { id: 'event', label: 'Events' },
  { id: 'error', label: 'Errors' },
];

const BUCKET_LABELS: Record<string, string> = {
  core: 'REST',
  search: 'Search',
  graphql: 'GraphQL',
  code_search: 'Code search',
};

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function resetsIn(resetAt: string, now: number): string {
  const seconds = Math.round((new Date(resetAt).getTime() - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'resets now';
  if (seconds < 60) return `resets in ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `resets in ${minutes} min`;
  return `resets in ${Math.round(minutes / 60)} h`;
}

/** A relative reset time that counts down between polls. */
function ResetsIn({ resetAt }: { resetAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span>{resetsIn(resetAt, now)}</span>;
}

function BucketCard({ bucket }: { bucket: DeveloperRateLimitBucket }) {
  const share = bucket.limit > 0 ? bucket.remaining / bucket.limit : 0;
  const low = share < LOW_REMAINING;
  const name = BUCKET_LABELS[bucket.resource] ?? bucket.resource;
  return (
    <Card
      className={cn('p-3', low && 'border-yellow-500/50')}
      data-testid={`bucket-${bucket.resource}`}
      data-low={low ? 'true' : 'false'}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{name}</span>
        {low && <span className="text-xs text-yellow-500">Low</span>}
      </div>
      <div className={cn('mt-1 text-sm tabular-nums', low && 'text-yellow-500')}>
        {bucket.remaining.toLocaleString()} / {bucket.limit.toLocaleString()}
      </div>
      <Progress
        value={1 - share}
        label={`${name}: ${bucket.used} of ${bucket.limit} used`}
        className={cn('mt-2 h-1', low && '[&>div]:bg-yellow-500')}
      />
      <div className="mt-1 text-xs text-muted-foreground">
        <ResetsIn resetAt={bucket.resetAt} />
      </div>
    </Card>
  );
}

function RateLimits({ data }: { data: DeveloperRateLimits }) {
  if (!data.connected) {
    return (
      <p className="text-sm text-muted-foreground">
        GitHub is not connected for this workspace.
      </p>
    );
  }
  const gatedUntil = [data.secondaryGate.restUntil, data.secondaryGate.graphqlUntil]
    .filter((v): v is string => !!v)
    .sort()
    .pop();
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {data.github.map((bucket) => (
          <BucketCard key={bucket.resource} bucket={bucket} />
        ))}
      </div>
      {data.graphqlBudget?.deferring && (
        <p className="text-xs text-yellow-500">
          Talyn is deferring background refreshes to protect your GraphQL budget until{' '}
          {clock(data.graphqlBudget.resetAt)}.
        </p>
      )}
      {gatedUntil && (
        <p className="text-xs text-yellow-500">
          GitHub rate-limited this account. Talyn holds requests until {clock(gatedUntil)}.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {data.login ? `Connected as @${data.login}. ` : ''}
        {data.scopes.length > 0 ? `Scopes: ${data.scopes.join(', ')}` : 'No scopes on this token.'}
      </p>
    </div>
  );
}

function AgentRow({ agent }: { agent: DeveloperAgent }) {
  return (
    <div className="py-2" data-testid={`agent-${agent.agent}`}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{fleetAgentLabel(agent.agent)}</span>
        {agent.state === 'ready' && <span className="text-muted-foreground">Ready</span>}
        {agent.state === 'reauth' && <span className="text-destructive">Reconnect needed</span>}
        {agent.state === 'held' && agent.hold && (
          <span className="text-yellow-500">
            Usage limit reached, Talyn tries it again at {clock(agent.hold.retryAfter)}
          </span>
        )}
      </div>
      {agent.state === 'held' && agent.hold?.detail && (
        <p className="mt-0.5 text-xs text-muted-foreground">{agent.hold.detail}</p>
      )}
    </div>
  );
}

function ActivityRow({ event }: { event: DeveloperActivityEvent }) {
  const [open, setOpen] = useState(false);
  const hasMeta = !!event.meta && Object.keys(event.meta).length > 0;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li
      className={cn('border-b border-border/50 last:border-0', !event.ok && 'text-destructive')}
      data-testid="activity-row"
      data-ok={event.ok ? 'true' : 'false'}
    >
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-xs',
          hasMeta ? 'hover:bg-muted/50' : 'cursor-default'
        )}
        onClick={() => hasMeta && setOpen((v) => !v)}
        aria-expanded={hasMeta ? open : undefined}
      >
        <Chevron className={cn('h-3 w-3 shrink-0', !hasMeta && 'invisible')} />
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
        <span className="w-24 shrink-0 truncate">{event.service}</span>
        <span className="min-w-0 flex-1 truncate" title={event.summary}>
          {event.summary}
        </span>
        <span className="shrink-0">{event.ok ? 'OK' : 'Failed'}</span>
        <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
          {event.durationMs !== undefined ? `${Math.round(event.durationMs)} ms` : ''}
        </span>
      </button>
      {open && hasMeta && (
        <pre className="overflow-x-auto bg-muted/40 px-7 py-2 text-xs text-foreground">
          {JSON.stringify(event.meta, null, 2)}
        </pre>
      )}
    </li>
  );
}

function countLine(activity: DeveloperActivity): string {
  const { total, failed } = activity.counts;
  return `${total} ${total === 1 ? 'event' : 'events'}, ${failed} failed`;
}

/** How far back the shared backend window reaches, in whole minutes. */
function windowNote(activity: DeveloperActivity): string | null {
  if (!activity.buffer.oldestAt) return null;
  const minutes = Math.max(
    1,
    Math.round((Date.now() - new Date(activity.buffer.oldestAt).getTime()) / 60_000)
  );
  return `From the last ${minutes} min of backend activity.`;
}

export function DeveloperInternals() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [chip, setChip] = useState<Chip>('all');
  const [rateLimits, setRateLimits] = useState<DeveloperRateLimits | null>(null);
  const [agents, setAgents] = useState<DeveloperAgent[]>([]);
  const [activity, setActivity] = useState<DeveloperActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // Only the newest load may write state. An older one can finish late, after
  // a chip or workspace change.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const [limits, agentList, events] = await Promise.allSettled([
      workspaceId ? api.developer.rateLimits(workspaceId) : Promise.resolve(null),
      workspaceId ? api.developer.agents(workspaceId) : Promise.resolve(null),
      api.developer.activity(chip === 'all' ? {} : { category: chip }),
    ]);
    if (seq !== loadSeq.current) return;
    // A failed part keeps its last data. Only the parts that answered change.
    if (limits.status === 'fulfilled' && limits.value) setRateLimits(limits.value);
    if (agentList.status === 'fulfilled' && agentList.value) setAgents(agentList.value.agents);
    if (events.status === 'fulfilled') setActivity(events.value);
    const failure = [limits, agentList, events].find((r) => r.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    setError(
      failure
        ? failure.reason instanceof Error
          ? failure.reason.message
          : 'Refresh failed'
        : null
    );
    setLoading(false);
  }, [workspaceId, chip]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, DEVELOPER_POLL_MS);
    // A tab that comes back shows fresh numbers at once, not after a full interval.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      // Drop the answer of a request that is still in flight.
      loadSeq.current += 1;
    };
  }, [load]);

  useEffect(() => {
    let alive = true;
    api.debug
      .getAccess()
      .then((access) => {
        if (alive) setIsAdmin(access.admin);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const note = activity ? windowNote(activity) : null;

  return (
    <div className="space-y-6" data-testid="developer-internals">
      <div className="flex items-center justify-end gap-3">
        {error && (
          <span className="text-xs text-destructive" role="alert">
            Refresh failed: {error}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      <section className="space-y-2">
        <h4 className="font-medium">GitHub rate limits</h4>
        {rateLimits ? (
          <RateLimits data={rateLimits} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </section>

      {agents.length > 0 && (
        <section className="space-y-2">
          <h4 className="font-medium">Agents</h4>
          <Card className="divide-y divide-border/50 px-3">
            {agents.map((agent) => (
              <AgentRow key={agent.agent} agent={agent} />
            ))}
          </Card>
        </section>
      )}

      <section className="space-y-2">
        <h4 className="font-medium">Recent activity</h4>
        <div className="flex flex-wrap gap-1.5">
          {CHIPS.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={chip === c.id}
              onClick={() => setChip(c.id)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                chip === c.id
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        {activity && activity.events.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {countLine(activity)}
              {note ? `. ${note}` : ''}
            </p>
            <Card className="overflow-hidden">
              <ul>
                {activity.events.map((event) => (
                  <ActivityRow key={event.id} event={event} />
                ))}
              </ul>
            </Card>
          </>
        )}
        {activity && activity.events.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No recent activity for your account. Talyn keeps a short rolling window for all
            accounts.
          </p>
        )}
      </section>

      {isAdmin && (
        <p className="text-xs text-muted-foreground">
          Cross-account tooling is on admin.talyn.dev.
        </p>
      )}
    </div>
  );
}
