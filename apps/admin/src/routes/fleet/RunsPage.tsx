import { useNavigate, useSearchParams } from 'react-router-dom';
import { ADMIN_RUN_KINDS, type AdminRunRow } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, countdown, duration, mib, pct, relativeAge, usd } from '../../lib/format';
import {
  boxSizeLabel,
  countRuns,
  durationSeconds,
  idlePct,
  idleSeconds,
  isAsleep,
  isRealOrphan,
  isTerminal,
  looksWedged,
  runClaim,
  runKind,
  sleepSeconds,
} from '../../lib/fleetView';
import { ROUTES, routeTo } from '../../lib/routes';
import { useAdminMutation } from '../../hooks/useAdminMutation';
import { ConfirmMutationDialog } from '../../components/admin/ConfirmMutationDialog';
import { useCapability } from '../../components/auth/AdminGate';

/**
 * Every sandbox the fleet holds now, and the task runs it held before.
 *
 * Filter state lives in the URL (`useSearchParams`), not component state, so a
 * filtered view is a link an operator can paste into Slack. That is the same
 * reason drill-ins are routes rather than modals.
 *
 * Each live box is classified by the backend against tasks, sessions, threads
 * and review units. A session box opens its session; a task box opens the run.
 * "Orphan" means no Talyn row of any status names the box, and "superseded"
 * means a row names it but has moved on (archived, or on a newer box): a
 * cleanup candidate with an owner, not a leak.
 *
 * Rows are in time order, newest first, as the backend sends them. They used
 * to be ranked, orphans first, and the row an operator opened the page to find
 * was the one they had to hunt for. Orphans keep a tinted row and a count in
 * the header instead.
 */
const POLL_MS = 8_000;

const STATUSES = ['running', 'queued', 'completed', 'failed', 'cancelled'] as const;

/**
 * Below this, the idle share is noise rather than signal.
 *
 * Every run ends with a little trailing silence — the gap between its last
 * frame and the host recording the outcome — so a percentage on every row would
 * be a column of 1%s that trains the eye to skip it. Ten is where the number
 * starts meaning "a material part of this run was spent saying nothing".
 */
const IDLE_SHARE_WORTH_SHOWING = 10;

const KIND_LABEL: Record<string, string> = {
  task: 'task',
  session: 'session',
  thread: 'thread',
  review: 'review',
  unknown: 'other',
};

export function RunsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const host = params.get('host') ?? '';
  const status = params.get('status') ?? '';
  const kind = params.get('kind') ?? '';
  const owner = params.get('owner') ?? '';

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () =>
      api.admin.fleet.runs({
        host: host || undefined,
        status: status || undefined,
        kind: kind || undefined,
        owner: owner || undefined,
      }),
    { intervalMs: POLL_MS, deps: [host, status, kind, owner] }
  );
  // The registry only: it dials nothing, and it is what names the hosts.
  const hosts = useAdminQuery(() => api.admin.fleet.hosts(), {});
  const hostNames = [...new Set([...(hosts.data ?? []).map((h) => h.name), ...(host ? [host] : [])])].sort();

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const canMutate = useCapability('fleet.mutate');
  const cancel = useAdminMutation<AdminRunRow>(refresh);

  const rows = data ? data.items : null;
  const counts = countRuns(rows ?? []);
  const filtered = Boolean(host || status || kind || owner);

  const columns: Column<AdminRunRow>[] = [
    {
      key: 'run',
      header: 'Run',
      cell: (r) => (
        <div className="flex items-center gap-2">
          <CopyableId value={r.runId} />
          <Pill tone="muted" title="What the sandbox is for, read from its id">
            {KIND_LABEL[runKind(r)] ?? runKind(r)}
          </Pill>
          <ClaimPill run={r} />
          {r.adopted && (
            <Pill tone="muted" title="Re-attached after a fleetd restart">
              adopted
            </Pill>
          )}
        </div>
      ),
    },
    {
      key: 'what',
      header: 'What',
      cell: (r) => (
        <div className="min-w-0 max-w-[18rem]">
          <div className="truncate" title={r.title ?? undefined}>
            {r.title ?? <Muted />}
          </div>
          {(r.repo || r.workspaceName) && (
            <div className="truncate text-xs text-muted-foreground">
              {[r.repo, r.workspaceName].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      ),
    },
    { key: 'host', header: 'Host', cell: (r) => r.host ?? <Muted /> },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <StatusPill run={r} />,
    },
    { key: 'phase', header: 'Phase', cell: (r) => r.phase ?? <Muted /> },
    {
      key: 'duration',
      header: 'Took',
      cell: (r) => {
        const secs = durationSeconds(r);
        if (secs == null) return <Muted />;
        return (
          <span
            className="tabular-nums"
            title={
              isTerminal(r.status)
                ? `${absolute(r.startedAt ?? r.createdAt)} → ${absolute(r.endedAt)}`
                : `Started ${absolute(r.startedAt ?? r.createdAt)}; still running`
            }
          >
            {duration(secs)}
            {!isTerminal(r.status) && <span className="text-muted-foreground">…</span>}
          </span>
        );
      },
    },
    {
      key: 'idle',
      header: 'Idle',
      cell: (r) => {
        if (isAsleep(r)) {
          const slept = sleepSeconds(r);
          return (
            <span
              className="tabular-nums text-muted-foreground"
              title="Asleep, which is normal: the box costs no memory and no slot until its next turn"
            >
              {slept == null ? 'asleep' : `slept ${duration(slept)}`}
            </span>
          );
        }
        const idle = idleSeconds(r);
        if (idle == null) return <Muted />;
        const share = idlePct(r);
        return (
          <span
            className={looksWedged(r) ? 'font-medium text-destructive tabular-nums' : 'tabular-nums'}
            title={
              isTerminal(r.status)
                ? 'How long this run was silent on the vsock before it ended. A run reaped as wedged shows ~5 minutes here by definition; one that ended cleanly shows a second or two.'
                : 'Time since the last vsock frame of any kind'
            }
          >
            {duration(idle)}
            {share != null && share >= IDLE_SHARE_WORTH_SHOWING && (
              <span className="ml-1 text-muted-foreground">({share}%)</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'deadline',
      header: 'Deadline',
      cell: (r) => (
        <span className="tabular-nums" title={absolute(r.deadline)}>
          {countdown(r.deadline)}
        </span>
      ),
    },
    {
      key: 'memory',
      header: 'Memory',
      cell: (r) => {
        // Usage is absent, not zero, on a box whose VMM is gone (terminal or
        // asleep) and on a host with an older fleetd. The size still says what
        // the box is booted at.
        const size = boxSizeLabel(r);
        const share = r.memUsedMib != null ? pct(r.memUsedMib, r.memMib) : null;
        if (r.memUsedMib == null && !size) return <Muted />;
        return (
          <div
            className="tabular-nums"
            title={
              r.memUsedMib != null && r.memMib != null
                ? `Using ${mib(r.memUsedMib)} of a ${mib(r.memMib)} ceiling. The ceiling is what the guest booted at; its balloon holds it below that and lets it grow only as it needs to.`
                : undefined
            }
          >
            {r.memUsedMib != null ? (
              <>
                {mib(r.memUsedMib)}
                {share != null && (
                  <span className="ml-1 text-muted-foreground">({Math.round(share)}%)</span>
                )}
              </>
            ) : (
              <Muted />
            )}
            {size && (
              <div className="text-xs text-muted-foreground">
                {size}
                {r.diskMib ? ` · ${mib(r.diskMib)} disk` : ''}
              </div>
            )}
          </div>
        );
      },
    },
    { key: 'cost', header: 'Cost', cell: (r) => <span className="tabular-nums">{usd(r.costUsd)}</span> },
    {
      key: 'owner',
      header: 'Owner',
      cell: (r) => (
        <div className="min-w-0 text-xs">
          <div className="truncate">{r.ownerEmail ?? <Muted />}</div>
        </div>
      ),
    },
    ...(canMutate
      ? [
          {
            key: 'actions',
            header: '',
            cell: (r: AdminRunRow) =>
              !isTerminal(r.status) && r.status != null ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    cancel.start(r, ({ reason }) =>
                      api.admin.fleet.cancelRun(r.host ?? '-', r.runId, { reason })
                    );
                  }}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                >
                  Cancel
                </button>
              ) : null,
          } satisfies Column<AdminRunRow>,
        ]
      : []),
    {
      key: 'age',
      header: 'Started',
      cell: (r) => (
        <span className="tabular-nums" title={absolute(r.startedAt ?? r.createdAt)}>
          {relativeAge(r.startedAt ?? r.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Runs"
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span>{rows?.length ?? 0} shown</span>
          <Pill tone="info">{counts.running} running</Pill>
          <Pill tone="muted">{counts.asleep} asleep</Pill>
          {counts.superseded > 0 && (
            <Pill tone="warn" title="A Talyn row names the box, but it is archived or has moved on">
              {counts.superseded} superseded
            </Pill>
          )}
          {counts.orphaned > 0 && <Pill tone="critical">{counts.orphaned} orphaned</Pill>}
          {counts.wedged > 0 && <Pill tone="warn">{counts.wedged} possibly wedged</Pill>}
        </span>
      }
      onRefresh={refresh}
      refreshing={loading}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={kind}
            onChange={(e) => setFilter('kind', e.target.value)}
            aria-label="Filter by kind"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">All kinds</option>
            {ADMIN_RUN_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select
            value={host}
            onChange={(e) => setFilter('host', e.target.value)}
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
            onChange={(e) => setFilter('owner', e.target.value)}
            placeholder="owner email"
            aria-label="Filter by owner"
            className="w-36 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
          <select
            value={status}
            onChange={(e) => setFilter('status', e.target.value)}
            aria-label="Filter by status"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {/* Hosts we could not reach. Without this the list silently under-reports
          and an operator reads "no runs" as "the fleet is idle". */}
      {data?.degraded?.length ? (
        <div className="mb-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Couldn&apos;t reach {data.degraded.map((d) => d.host).join(', ')} — live run state for
          {data.degraded.length > 1 ? ' those hosts' : ' that host'} is missing from this list.
        </div>
      ) : null}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.runId}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage={filtered ? 'No runs match these filters' : 'No fleet runs yet'}
        emptyHint={
          filtered
            ? 'Clear the filters to see everything.'
            : 'Runs appear here once a task or a session starts on the fleet.'
        }
        onRowClick={(r) => navigate(runLink(r))}
        rowClassName={(r) => (isRealOrphan(r) ? 'bg-destructive/5' : undefined)}
      />

      <ConfirmMutationDialog
        open={Boolean(cancel.pending)}
        onClose={cancel.close}
        title="Cancel this run?"
        description={
          <>
            The microVM running <strong>{cancel.pending?.target.runId}</strong> on{' '}
            <strong>{cancel.pending?.target.host}</strong> will be torn down. Any work it has not
            already pushed is lost.
            {cancel.pending?.target.ownerEmail && (
              <> This belongs to {cancel.pending.target.ownerEmail}.</>
            )}
          </>
        }
        actionLabel="Cancel run"
        // Plain confirm: one operator, one named target on the row, and the
        // action is not escalating. Typing a 36-character run id to stop your own
        // stuck run was friction with nothing behind it.
        simple
        destructive
        analyticsAction="fleet.run.cancel"
        analyticsTargetType="run"
        onConfirm={async (input) => {
          await cancel.pending!.run(input);
          cancel.succeeded('Run cancelled');
        }}
      />
    </Page>
  );
}

/**
 * Where a row opens. A session or thread box opens its session, which shows the
 * box too. Anything else opens the run, with the host so a deploy without a
 * gateway knows which fleetd to ask.
 */
export function runLink(run: AdminRunRow): string {
  if (run.workbenchId && (run.kind === 'session' || run.kind === 'thread')) {
    return routeTo(ROUTES.session, { sessionId: run.workbenchId });
  }
  const base = routeTo(ROUTES.fleetRun, { runId: run.runId });
  return run.host ? `${base}?host=${encodeURIComponent(run.host)}` : base;
}

function ClaimPill({ run }: { run: AdminRunRow }) {
  const claim = runClaim(run);
  if (claim === 'orphan') {
    return run.selfTest ? (
      <Pill tone="muted" title="A guest self-test fired by the fleet's deploy script, not a Talyn task">
        self-test
      </Pill>
    ) : (
      <Pill tone="critical" title="No Talyn task, session, thread or review names this box">
        orphan
      </Pill>
    );
  }
  if (claim === 'superseded') {
    return (
      <Pill tone="warn" title={run.supersededReason ?? 'A cleanup candidate'}>
        superseded
      </Pill>
    );
  }
  return null;
}

function StatusPill({ run }: { run: AdminRunRow }) {
  if (isAsleep(run)) {
    const where = run.sleep?.kind === 'storage' ? 'in storage' : 'local';
    return (
      <Pill
        tone="muted"
        title={
          run.sleep?.kind === 'storage'
            ? 'Hibernated: a complete copy is in object storage'
            : run.sleep?.uploadError
              ? `Suspended on its host. The last hibernation upload failed: ${run.sleep.uploadError}`
              : 'Suspended on its host'
        }
      >
        asleep · {where}
      </Pill>
    );
  }
  if (looksWedged(run)) return <Pill tone="critical">wedged?</Pill>;
  switch (run.status) {
    case 'running':
      // Blue, not green: green is the "this finished and it was fine" colour,
      // and a run still in flight has not earned it. It also makes the one row
      // an operator can still act on scannable in a list of finished ones.
      return <Pill tone="info">running</Pill>;
    case 'queued':
      return <Pill tone="muted">queued</Pill>;
    case 'completed':
      return <Pill tone="good">completed</Pill>;
    case 'failed':
      return <Pill tone="critical">failed</Pill>;
    case 'cancelled':
      return <Pill tone="warn">cancelled</Pill>;
    default:
      return <Pill tone="muted">unknown</Pill>;
  }
}

function Muted() {
  return <span className="text-muted-foreground">—</span>;
}
