import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import type { AdminComputeUsageRow } from '@talyn/client';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { StatCard } from '../../components/ui/StatCard';
import { COMPUTE_RANGES, ComputeHoursPanel } from '../../components/admin/ComputeHoursPanel';
import { absolute, pct, relativeAge } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';

type Sort = 'period_hours' | 'all_time_hours' | 'sessions' | 'running' | 'last_active';

const hours = (value: number) => value.toFixed(1);

export function ComputeUsagePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sort = (params.get('sort') ?? 'period_hours') as Sort;
  const order = params.get('order') === 'asc' ? 'asc' : 'desc';
  const rawDays = Number(params.get('days'));
  const days = (COMPUTE_RANGES as readonly number[]).includes(rawDays) ? rawDays : 30;
  const userId = params.get('user') ?? '';
  const [search, setSearch] = useState(q);

  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (search === q) return;
    const timer = window.setTimeout(() => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (search) next.set('q', search);
        else next.delete('q');
        return next;
      }, { replace: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, q, setParams]);

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () => api.admin.computeUsage({ q: q || undefined, sort, order }),
    { deps: [q, sort, order] }
  );
  const daily = useAdminQuery(
    () => api.admin.computeDaily({ days, userId: userId || undefined }),
    { deps: [days, userId] }
  );

  function setParam(key: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }

  function refreshAll() {
    refresh();
    daily.refresh();
  }

  function setSort(nextSort: Sort) {
    const next = new URLSearchParams(params);
    const nextOrder = sort === nextSort && order === 'desc' ? 'asc' : 'desc';
    next.set('sort', nextSort);
    next.set('order', nextOrder);
    setParams(next, { replace: true });
  }

  function heading(label: string, key: Sort) {
    return (
      <button
        type="button"
        onClick={() => setSort(key)}
        aria-label={`Sort by ${label}`}
        className="whitespace-nowrap hover:text-foreground"
      >
        {label} {sort === key ? (order === 'desc' ? '↓' : '↑') : '↕'}
      </button>
    );
  }

  const numeric = 'text-right tabular-nums';
  const columns: Column<AdminComputeUsageRow>[] = [
    {
      key: 'account',
      header: 'Account',
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{row.email}</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setParam('user', userId === row.user_id ? '' : row.user_id);
            }}
            aria-label={`Show compute hours for ${row.email}`}
            aria-pressed={userId === row.user_id}
            title="Show compute hours over time"
            className={userId === row.user_id ? 'text-blue-500' : 'text-muted-foreground hover:text-foreground'}
          >
            <BarChart3 className="h-3.5 w-3.5" />
          </button>
          <Pill tone={row.tier === 'free' || row.tier == null ? 'muted' : 'good'}>{row.tier ?? 'no period'}</Pill>
          {row.plan_override && <Pill tone="warn">override</Pill>}
        </div>
      ),
    },
    {
      key: 'period',
      header: heading('Box-hours this period', 'period_hours'),
      headClassName: numeric,
      className: numeric,
      cell: (row) => (
        <div className="ml-auto w-36">
          <div>{hours(row.period_used_hours)}</div>
          <div className="text-xs text-muted-foreground">of {hours(row.period_included_hours)} included</div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-blue-500"
              style={{ width: `${pct(row.period_used_hours, row.period_included_hours) ?? 0}%` }}
            />
          </div>
        </div>
      ),
    },
    {
      key: 'week',
      header: 'Last 7 days',
      headClassName: numeric,
      className: numeric,
      cell: (row) => hours(row.hours_last_7_days),
    },
    {
      key: 'all',
      header: heading('All time', 'all_time_hours'),
      headClassName: numeric,
      className: numeric,
      cell: (row) => hours(row.all_time_hours),
    },
    {
      key: 'sessions',
      header: heading('Sessions', 'sessions'),
      headClassName: numeric,
      className: numeric,
      cell: (row) => (
        <span>{row.sessions_total} <span className="text-xs text-muted-foreground">({row.sessions_active} active)</span></span>
      ),
    },
    {
      key: 'running',
      header: heading('Running now', 'running'),
      headClassName: numeric,
      className: numeric,
      cell: (row) => row.boxes_running,
    },
    {
      key: 'active',
      header: heading('Last active', 'last_active'),
      headClassName: numeric,
      className: numeric,
      cell: (row) => <span title={absolute(row.last_active_at)}>{relativeAge(row.last_active_at)}</span>,
    },
  ];

  return (
    <Page
      title="Compute usage"
      subtitle={`${data?.totals.users ?? 0} accounts${q ? ' match' : ' with usage or sessions'}`}
      onRefresh={refreshAll}
      refreshing={loading || daily.loading}
      actions={
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search email"
          aria-label="Search email"
          className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
        />
      }
    >
      <ComputeHoursPanel
        data={daily.data}
        error={daily.error}
        days={days}
        userId={userId}
        onDaysChange={(value) => setParam('days', value === 30 ? '' : String(value))}
        onUserChange={(value) => setParam('user', value)}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Accounts" value={data?.totals.users ?? '—'} />
        <StatCard label="This period" value={data ? `${hours(data.totals.period_used_hours)} h` : '—'} />
        <StatCard label="All time" value={data ? `${hours(data.totals.all_time_hours)} h` : '—'} />
        <StatCard label="Sessions" value={data?.totals.sessions_total ?? '—'} />
        <StatCard label="Running now" value={data?.totals.boxes_running ?? '—'} />
      </div>
      <DataTable
        rows={data?.items ?? null}
        columns={columns}
        rowKey={(row) => row.user_id}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage={q ? 'No accounts match' : 'No compute usage yet'}
        emptyHint={q ? 'Try another email.' : undefined}
        onRowClick={(row) => navigate(routeTo(ROUTES.user, { userId: row.user_id }))}
      />
      {data && data.totals.users > data.items.length && (
        <p className="mt-3 text-xs text-muted-foreground">Showing {data.items.length} of {data.totals.users} accounts.</p>
      )}
    </Page>
  );
}
