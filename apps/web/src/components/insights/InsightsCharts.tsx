import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { formatShortDate } from '../../lib/usageBilling';

/** A figure with its label. Wraps on a phone: the value never sets the width. */
export function Stat({ label, value, hint, dataAttr }: { label: string; value: ReactNode; hint?: ReactNode; dataAttr?: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-background/40 p-3" data-attr={dataAttr}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 break-words text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-2 lg:grid-cols-4', className)}>{children}</div>;
}

export function SubHeading({ children }: { children: ReactNode }) {
  return <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h4>;
}

/**
 * One bar per UTC day. Bars shrink to fit the card, so a year of days still
 * fits a phone without a horizontal scroll.
 */
export function DayBars({
  label,
  days,
  format,
  dataAttr,
}: {
  label: string;
  days: readonly { date: string; value: number }[];
  format: (value: number) => string;
  dataAttr?: string;
}) {
  if (days.length === 0) return null;
  const max = Math.max(0, ...days.map((d) => d.value));
  const first = days[0].date;
  const last = days[days.length - 1].date;
  return (
    <figure className="min-w-0" data-attr={dataAttr}>
      <figcaption className="mb-2 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">Peak {format(max)}</span>
      </figcaption>
      <div role="group" aria-label={label} className="flex h-28 items-end gap-px overflow-hidden rounded-md bg-muted/40 p-1">
        {days.map((day) => {
          const text = `${formatShortDate(`${day.date}T00:00:00Z`)}: ${format(day.value)}`;
          const height = max > 0 ? Math.max(day.value > 0 ? 2 : 0, (day.value / max) * 100) : 0;
          return (
            <div key={day.date} className="flex h-full min-w-0 flex-1 items-end" title={text}>
              <div role="img" aria-label={text} className="w-full rounded-sm bg-primary" style={{ height: `${height}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{formatShortDate(`${first}T00:00:00Z`)}</span>
        {last !== first && <span>{formatShortDate(`${last}T00:00:00Z`)}</span>}
      </div>
    </figure>
  );
}

export interface HBarRow {
  key: string;
  label: ReactNode;
  /** Plain text of the label, for the bar's accessible name. */
  labelText: string;
  value: number;
  valueText: string;
  detail?: ReactNode;
}

/** Horizontal bars for a breakdown. Labels wrap; the bar sits under them. */
export function HBars({ rows, label, dataAttr }: { rows: readonly HBarRow[]; label: string; dataAttr?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2" aria-label={label} data-attr={dataAttr}>
      {rows.map((row) => (
        <li key={row.key} className="min-w-0 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 break-words">{row.label}</span>
            <span className="shrink-0 tabular-nums">{row.valueText}</span>
          </div>
          {row.detail && <div className="break-words text-xs text-muted-foreground">{row.detail}</div>}
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" title={`${row.labelText}: ${row.valueText}`}>
            <div
              role="img"
              aria-label={`${row.labelText}: ${row.valueText}`}
              className="h-full rounded-full bg-primary"
              style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
