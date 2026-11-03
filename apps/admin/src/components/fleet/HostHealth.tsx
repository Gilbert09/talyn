import { Link } from 'react-router-dom';
import type { AdminFleetHost, AdminHostCondition, AdminHostHealth } from '@talyn/shared';
import { Pill } from '../layout/Page';
import { bytes, mib } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';
import { ALERT_LABEL } from '../layout/HostAlertsBanner';

/**
 * A host's health as fleetd reports it on `GET /v1/stats`: the fleet store's
 * disk pressure, failed hibernation uploads, failing bakes, and the
 * conditions the YAS control plane raises alerts from.
 *
 * Absent (a host we could not reach, or an older fleetd) renders as unknown,
 * never as healthy.
 */

export function DiskPressurePill({ health }: { health: AdminHostHealth | null | undefined }) {
  if (!health || !health.diskPressure) return <Pill tone="muted">unknown</Pill>;
  const free = bytes(health.diskFreeBytes);
  switch (health.diskPressure) {
    case 'critical':
      return (
        <Pill tone="critical" title="Below the hard floor: admission refuses boxes">
          critical · {free} free
        </Pill>
      );
    case 'low':
      return (
        <Pill tone="warn" title="Below the reserve: admission is careful">
          low · {free} free
        </Pill>
      );
    default:
      return <Pill tone="good">{free} free</Pill>;
  }
}

export function ConditionPills({ conditions }: { conditions: AdminHostCondition[] | null | undefined }) {
  if (conditions == null) return <span className="text-muted-foreground">—</span>;
  if (conditions.length === 0) return <Pill tone="good">none</Pill>;
  return (
    <span className="flex flex-wrap gap-1">
      {conditions.map((c) => (
        <Pill key={c.kind} tone={c.severity === 'critical' ? 'critical' : 'warn'} title={c.detail}>
          {ALERT_LABEL[c.kind] ?? c.kind}
        </Pill>
      ))}
    </span>
  );
}

export function BoxCounts({ host }: { host: AdminFleetHost }) {
  if (!host.boxes) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="tabular-nums" title="Sandboxes on this host, every tenant">
      {host.boxes.running} running
      <span className="text-muted-foreground"> · {host.boxes.asleep} asleep</span>
      {host.boxes.queued > 0 && <span className="text-muted-foreground"> · {host.boxes.queued} queued</span>}
    </span>
  );
}

/** The detail panel for one host. */
export function HostHealthPanel({ host }: { host: AdminFleetHost }) {
  const h = host.health;
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Health</h2>
      {host.conditions && host.conditions.length > 0 && (
        <ul className="mb-3 space-y-1">
          {host.conditions.map((c) => (
            <li
              key={c.kind}
              className={
                c.severity === 'critical'
                  ? 'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive'
                  : 'rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300'
              }
            >
              <span className="font-medium">{ALERT_LABEL[c.kind] ?? c.kind}: </span>
              {c.detail}
            </li>
          ))}
        </ul>
      )}
      {!h ? (
        <p className="text-sm text-muted-foreground">
          {host.live ? 'This host’s fleetd does not report health yet.' : 'No live read of this host.'}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-card p-3 text-sm sm:grid-cols-4">
            <Item label="Fleet store" value={<DiskPressurePill health={h} />} />
            <Item label="Growth committed" value={h.diskCommittedMib != null ? mib(h.diskCommittedMib) : '—'} />
            <Item label="Reserve" value={h.diskReserveMib != null ? mib(h.diskReserveMib) : '—'} />
            <Item label="Hard floor" value={h.diskHardFloorMib != null ? mib(h.diskHardFloorMib) : '—'} />
            <Item label="Boxes" value={<BoxCounts host={host} />} />
            <Item
              label="Hibernation uploads failing"
              value={
                h.hibernateUploadFailing > 0 ? (
                  <Pill tone="warn">{h.hibernateUploadFailing}</Pill>
                ) : (
                  '0'
                )
              }
            />
            <Item
              label="Repos with failing bakes"
              value={
                h.bakeFailingRepos > 0 ? (
                  <Pill tone="warn" title={`Longest streak: ${h.bakeMaxConsecutiveFailures} failures in a row`}>
                    {h.bakeFailingRepos}
                  </Pill>
                ) : (
                  '0'
                )
              }
            />
            <Item label="Longest bake failure streak" value={String(h.bakeMaxConsecutiveFailures)} />
          </dl>
          {h.diskTopWriters.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Top disk writers</div>
              <ul className="space-y-0.5 text-xs">
                {h.diskTopWriters.map((w) => (
                  <li key={w.id} className="tabular-nums">
                    <Link to={routeTo(ROUTES.fleetRun, { runId: w.id }) + `?host=${encodeURIComponent(host.name)}`} className="font-mono underline">
                      {w.id}
                    </Link>{' '}
                    {mib(w.writtenMib)} written · {mib(w.rateMibPerMin)}/min
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate">{value}</dd>
    </div>
  );
}
