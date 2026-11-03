import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AdminSessionSummary } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { absolute, relativeAge } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';
import { SessionStatusPill, SandboxStatePill } from './sessionPills';

/**
 * Sessions and threads across every account.
 *
 * The page an operator opens when somebody says "my session is stuck". The
 * state filter carries the questions that come up: which sessions are stuck
 * provisioning, which failed, which are asleep. Filters live in the URL so a
 * filtered view is a link.
 */
const POLL_MS = 15_000;

const STATES: Array<[string, string]> = [
  ['live', 'Live'],
  ['stuck', 'Stuck provisioning'],
  ['failing', 'Failed'],
  ['asleep', 'Asleep'],
  ['archived', 'Archived'],
  ['all', 'All'],
];

export function SessionsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const kind = params.get('kind') ?? '';
  const state = params.get('state') ?? 'live';
  const host = params.get('host') ?? '';
  const owner = params.get('owner') ?? '';
  const before = params.get('before') ?? '';

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () =>
      api.admin.sessions.list({
        q: q || undefined,
        kind: kind || undefined,
        state,
        host: host || undefined,
        owner: owner || undefined,
        before: before || undefined,
      }),
    { intervalMs: POLL_MS, deps: [q, kind, state, host, owner, before] }
  );
  const hosts = useAdminQuery(() => api.admin.fleet.hosts(), {});
  const hostNames = [...new Set([...(hosts.data ?? []).map((h) => h.name), ...(host ? [host] : [])])].sort();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // A new filter starts from the first page.
    if (key !== 'before') next.delete('before');
    setParams(next, { replace: true });
  }

  const items = data?.items ?? null;
  const stuck = items?.filter((s) => s.stuckProvisioning).length ?? 0;
  const failing = items?.filter((s) => s.status === 'error' || s.status === 'archiveError').length ?? 0;
  const running = items?.filter((s) => s.runningChats > 0).length ?? 0;

  const columns: Column<AdminSessionSummary>[] = [
    {
      key: 'title',
      header: 'Session',
      cell: (s) => (
        <div className="min-w-0 max-w-[22rem]">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium" title={s.title}>
              {s.title}
            </span>
            {s.kind === 'thread' && <Pill tone="muted">thread</Pill>}
            {s.source === 'slack' && <Pill tone="muted">Slack</Pill>}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[s.repoFullName, s.branch].filter(Boolean).join(' · ') || s.name}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => (
        <div className="flex flex-wrap items-center gap-1">
          <SessionStatusPill session={s} />
          {s.runningChats > 0 && <Pill tone="info">{s.runningChats} turn running</Pill>}
        </div>
      ),
    },
    { key: 'sandbox', header: 'Sandbox', cell: (s) => <SandboxStatePill state={s.sandboxState} runtime={s.runtime} /> },
    { key: 'host', header: 'Host', cell: (s) => <span className="text-xs">{s.fleetHost ?? '—'}</span> },
    {
      key: 'agent',
      header: 'Agent',
      cell: (s) => (
        <span className="text-xs">
          {s.agent}
          {s.sandboxSize && <span className="text-muted-foreground"> · {s.sandboxSize}</span>}
        </span>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      cell: (s) => (
        <div className="min-w-0 text-xs">
          <div className="truncate">{s.ownerEmail ?? '—'}</div>
          <div className="truncate text-muted-foreground">{s.workspaceName ?? s.workspaceId}</div>
        </div>
      ),
    },
    {
      key: 'activity',
      header: 'Last activity',
      cell: (s) => (
        <span className="tabular-nums" title={absolute(s.lastActivityAt)}>
          {relativeAge(s.lastActivityAt)}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (s) => (
        <span className="tabular-nums" title={absolute(s.createdAt)}>
          {relativeAge(s.createdAt)}
        </span>
      ),
    },
  ];

  const filtered = Boolean(q || kind || host || owner || state !== 'live');

  return (
    <Page
      title="Sessions"
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span>
            {items?.length ?? 0} shown{data?.nextCursor ? ' (more available)' : ''}
          </span>
          {running > 0 && <Pill tone="info">{running} with a turn running</Pill>}
          {stuck > 0 && <Pill tone="warn">{stuck} stuck provisioning</Pill>}
          {failing > 0 && <Pill tone="critical">{failing} failed</Pill>}
        </span>
      }
      onRefresh={refresh}
      refreshing={loading}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
            placeholder="title, repository, branch"
            aria-label="Search sessions"
            className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
          <select
            value={state}
            onChange={(e) => setParam('state', e.target.value === 'live' ? '' : e.target.value)}
            aria-label="Filter by state"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            {STATES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(e) => setParam('kind', e.target.value)}
            aria-label="Filter by kind"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">Sessions and threads</option>
            <option value="session">Sessions</option>
            <option value="thread">Threads</option>
          </select>
          <select
            value={host}
            onChange={(e) => setParam('host', e.target.value)}
            aria-label="Filter by host"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">All hosts</option>
            {hostNames.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          <input
            value={owner}
            onChange={(e) => setParam('owner', e.target.value)}
            placeholder="owner email"
            aria-label="Filter by owner"
            className="w-36 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
        </div>
      }
    >
      <DataTable
        rows={items}
        columns={columns}
        rowKey={(s) => s.id}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage={filtered ? 'No sessions match these filters' : 'No sessions yet'}
        emptyHint={filtered ? 'Clear the filters to see more.' : undefined}
        onRowClick={(s) => navigate(routeTo(ROUTES.session, { sessionId: s.id }))}
        rowClassName={(s) =>
          s.status === 'error' || s.status === 'archiveError'
            ? 'bg-destructive/5'
            : s.stuckProvisioning
              ? 'bg-amber-500/5'
              : undefined
        }
      />

      {(before || data?.nextCursor) && (
        <div className="mt-3 flex items-center gap-2 text-xs">
          {before && (
            <button
              onClick={() => setParam('before', '')}
              className="rounded-md border border-border px-2.5 py-1.5 hover:bg-accent"
            >
              First page
            </button>
          )}
          {data?.nextCursor && (
            <button
              onClick={() => setParam('before', data.nextCursor!)}
              className="rounded-md border border-border px-2.5 py-1.5 hover:bg-accent"
            >
              Next page
            </button>
          )}
        </div>
      )}
    </Page>
  );
}
