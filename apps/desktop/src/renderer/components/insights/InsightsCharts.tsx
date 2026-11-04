import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { formatShortDate } from '../../lib/usageBilling';

/**
 * CSS bars for the Insights page. There is no chart library on purpose: a
 * day series and a few breakdowns do not need one. Every bar carries its
 * value in a `title` and an aria-label.
 */

export interface DayBarPoint {
  date: string;
  value: number;
  /** "3.5 box-hours", read with the date in the bar's title. */
  valueText: string;
}

export function DayBars({ points, label, testId }: { points: DayBarPoint[]; label: string; testId?: string }) {
  const max = Math.max(0, ...points.map((p) => p.value));
  if (points.length === 0) return null;
  return (
    <div data-testid={testId}>
      <div role="list" aria-label={label} className="flex h-28 items-end gap-px">
        {points.map((p) => {
          const text = `${formatShortDate(`${p.date}T00:00:00.000Z`)}: ${p.valueText}`;
          const height = max > 0 ? Math.max(p.value > 0 ? 2 : 0, (p.value / max) * 100) : 0;
          return (
            <div
              key={p.date}
              role="listitem"
              aria-label={text}
              title={text}
              className="flex h-full min-w-0 flex-1 items-end rounded-sm hover:bg-muted/60"
            >
              <div className="w-full rounded-sm bg-primary/80" style={{ height: `${height}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{formatShortDate(`${points[0].date}T00:00:00.000Z`)}</span>
        {points.length > 1 && <span>{formatShortDate(`${points[points.length - 1].date}T00:00:00.000Z`)}</span>}
      </div>
    </div>
  );
}

export interface BreakdownRow {
  key: string;
  label: ReactNode;
  value: number;
  valueText: string;
  /** Extra text after the value, such as a box count. */
  detail?: string;
}

/** Horizontal bars, each against the largest value in the list. */
export function BreakdownBars({ rows, label, className }: { rows: BreakdownRow[]; label: string; className?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className={cn('space-y-1.5', className)}>
      {rows.map((row) => {
        const width = max > 0 ? Math.max(row.value > 0 ? 1 : 0, (row.value / max) * 100) : 0;
        const text = row.detail ? `${row.valueText}, ${row.detail}` : row.valueText;
        return (
          <li key={row.key} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{text}</span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted" title={text} aria-hidden>
              <div className="h-full rounded-full bg-primary/80" style={{ width: `${width}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function StatTile({ label, value, detail, testId }: { label: string; value: ReactNode; detail?: ReactNode; testId?: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2" data-testid={testId}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-[15px] font-semibold tabular-nums">{value}</p>
      {detail && <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function SubTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>;
}
