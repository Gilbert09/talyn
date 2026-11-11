import { useState } from 'react';
import type { AdminComputeDaily } from '@talyn/client';
import { StatCard } from '../ui/StatCard';
import { pctLabel } from '../../lib/format';
import { cn } from '../../lib/utils';

export const COMPUTE_RANGES = [7, 30, 90] as const;

const KIND_LABELS: Record<string, string> = {
  workbench: 'Sessions',
  task: 'Tasks',
  review_unit: 'Reviews',
};

const hours = (value: number) => value.toFixed(1);

export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Box-hours per UTC day, with a range and an account filter.
 *
 * Presentational: the page owns the query so one Refresh button reloads the
 * chart and the table together.
 */
export function ComputeHoursPanel({
  data,
  error,
  days,
  userId,
  onDaysChange,
  onUserChange,
}: {
  data: AdminComputeDaily | null;
  error: string | null;
  days: number;
  userId: string;
  onDaysChange: (days: number) => void;
  onUserChange: (userId: string) => void;
}) {
  const options = data?.users ?? [];
  const selectedMissing = userId !== '' && !options.some((row) => row.user_id === userId);
  const allHours = options.reduce((sum, row) => sum + row.hours, 0);
  const activeDays = data?.days.filter((point) => point.hours > 0).length ?? 0;

  return (
    <section aria-label="Compute hours over time" className="mb-6 rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Compute hours over time</h2>
          <p className="text-xs text-muted-foreground">
            Box-hours per UTC day: wall-clock hours times the box size weight.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={userId}
            onChange={(event) => onUserChange(event.target.value)}
            aria-label="Filter by account"
            className="w-56 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">All accounts</option>
            {selectedMissing && <option value={userId}>{data?.user_email ?? userId}</option>}
            {options.map((row) => (
              <option key={row.user_id} value={row.user_id}>
                {row.email ?? row.user_id} ({hours(row.hours)} h)
              </option>
            ))}
          </select>
          <div role="group" aria-label="Range" className="flex overflow-hidden rounded-md border border-border text-xs">
            {COMPUTE_RANGES.map((range) => (
              <button
                key={range}
                type="button"
                aria-pressed={days === range}
                onClick={() => onDaysChange(range)}
                className={cn(
                  'px-2 py-1.5',
                  days === range ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {range}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && !data && <p className="mb-3 text-xs text-destructive">Compute hours unavailable: {error}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="Box-hours"
          value={data ? `${hours(data.totals.hours)} h` : '—'}
          hint={data ? `${hours(data.totals.wall_hours)} wall-clock hours` : undefined}
        />
        <StatCard
          label="Per day"
          value={data ? `${hours(data.totals.hours / data.days.length)} h` : '—'}
          hint={data ? `${activeDays} of ${data.days.length} days active` : undefined}
        />
        <StatCard
          label="Peak day"
          value={data ? `${hours(data.totals.peak_hours)} h` : '—'}
          hint={data?.totals.peak_day ? dayLabel(data.totals.peak_day) : undefined}
        />
        <StatCard label="Boxes started" value={data?.totals.boxes_started ?? '—'} />
        {userId ? (
          <StatCard label="Share of all hours" value={data ? pctLabel(data.totals.hours, allHours) : '—'} />
        ) : (
          <StatCard label="Accounts with usage" value={data ? options.length : '—'} />
        )}
      </div>

      {data && <DailyBars days={data.days} />}

      {data && (
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Breakdown
            title="By kind"
            rows={data.by_kind.map((row) => ({ key: row.key, label: KIND_LABELS[row.key] ?? row.key, hours: row.hours }))}
            total={data.totals.hours}
          />
          <Breakdown
            title="By box size"
            rows={data.by_size.map((row) => ({ key: row.key, label: row.key, hours: row.hours }))}
            total={data.totals.hours}
          />
          {!userId && (
            <Breakdown
              title="Top accounts"
              rows={options.slice(0, 8).map((row) => ({ key: row.user_id, label: row.email ?? row.user_id, hours: row.hours }))}
              total={allHours}
              onSelect={onUserChange}
            />
          )}
        </div>
      )}
    </section>
  );
}

function DailyBars({ days }: { days: AdminComputeDaily['days'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...days.map((point) => point.hours), 0);
  const point = hover == null ? null : days[hover];
  const ticks = [0, Math.floor((days.length - 1) / 2), days.length - 1].filter((v, i, all) => all.indexOf(v) === i);

  return (
    <div>
      <div className="flex gap-2">
        <div className="flex h-40 w-10 flex-col justify-between text-right text-[10px] tabular-nums text-muted-foreground">
          <span>{hours(max)} h</span>
          <span>0</span>
        </div>
        <div className="relative flex-1" onMouseLeave={() => setHover(null)}>
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-border" />
          <div className="flex h-40 items-end gap-[2px] border-b border-border">
            {days.map((day, index) => (
              <div
                key={day.day}
                data-testid="compute-day"
                aria-label={`${dayLabel(day.day)}: ${hours(day.hours)} box-hours`}
                onMouseEnter={() => setHover(index)}
                className="flex h-full flex-1 items-end"
              >
                <div
                  className={cn(
                    'w-full rounded-t bg-blue-500 transition-opacity dark:bg-blue-400',
                    hover != null && hover !== index && 'opacity-50'
                  )}
                  style={{ height: max > 0 && day.hours > 0 ? `max(2px, ${(day.hours / max) * 100}%)` : 0 }}
                />
              </div>
            ))}
          </div>
          {point && hover != null && (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1.5 text-xs shadow-md"
              style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
            >
              <div className="font-medium">{dayLabel(point.day)}</div>
              <div className="tabular-nums">{hours(point.hours)} box-hours</div>
              <div className="tabular-nums text-muted-foreground">{hours(point.wall_hours)} wall-clock hours</div>
              <div className="tabular-nums text-muted-foreground">{point.boxes_started} boxes started</div>
            </div>
          )}
          <div className="relative mt-1 h-4 text-[10px] text-muted-foreground">
            {ticks.map((index) => (
              <span
                key={index}
                className={cn(
                  'absolute',
                  index === 0 ? 'left-0' : index === days.length - 1 ? 'right-0' : '-translate-x-1/2'
                )}
                style={index !== 0 && index !== days.length - 1 ? { left: `${((index + 0.5) / days.length) * 100}%` } : undefined}
              >
                {dayLabel(days[index].day)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>Box-hours per day</caption>
        <thead>
          <tr><th>Day</th><th>Box-hours</th><th>Wall-clock hours</th><th>Boxes started</th></tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}>
              <td>{day.day}</td><td>{hours(day.hours)}</td><td>{hours(day.wall_hours)}</td><td>{day.boxes_started}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  total,
  onSelect,
}: {
  title: string;
  rows: { key: string; label: string; hours: number }[];
  total: number;
  onSelect?: (key: string) => void;
}) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No usage in this range.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const label = (
              <>
                <div className="flex justify-between gap-2 text-xs">
                  <span className="truncate">{row.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {hours(row.hours)} h · {pctLabel(row.hours, total)}
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-blue-500 dark:bg-blue-400"
                    style={{ width: `${total > 0 ? (row.hours / total) * 100 : 0}%` }}
                  />
                </div>
              </>
            );
            return (
              <li key={row.key}>
                {onSelect ? (
                  <button
                    type="button"
                    onClick={() => onSelect(row.key)}
                    aria-label={`Filter by ${row.label}`}
                    className="block w-full rounded text-left hover:bg-muted/50"
                  >
                    {label}
                  </button>
                ) : (
                  label
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
