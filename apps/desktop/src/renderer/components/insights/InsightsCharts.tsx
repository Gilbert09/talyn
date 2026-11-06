import { axisStep, axisTick } from './InsightsAxis';
import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { formatShortDate } from '../../lib/usageBilling';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';

const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

function dateTickIndexes(length: number): number[] {
  const count = Math.min(length, 4);
  return Array.from({ length: count }, (_, i) =>
    Math.round((i * (length - 1)) / (count - 1 || 1)),
  );
}

export interface DayBarPoint {
  date: string;
  value: number;
  /** Text for the exact day value and any detail. */
  valueText: string;
}

export function DayBars({
  points,
  label,
  testId,
}: {
  points: DayBarPoint[];
  label: string;
  testId?: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const max = Math.max(0, ...points.map((p) => p.value));
  const step = axisStep(max);
  const axisMax = step * 3;
  if (points.length === 0) return null;
  return (
    <div data-testid={testId}>
      <div className="flex gap-2">
        <div
          aria-label="Value axis"
          className="relative h-28 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground"
        >
          <span className="invisible whitespace-nowrap">{axisTick(axisMax, step)}</span>
          <div className="absolute inset-x-0 bottom-2 top-3">
            {[0, 1, 2, 3].map((tick) => (
              <span
                key={tick}
                className="absolute right-0 whitespace-nowrap"
                style={{ bottom: `calc(${(tick / 3) * 100}% - 0.5em)` }}
              >
                {axisTick(step * tick, step)}
              </span>
            ))}
          </div>
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            role="list"
            aria-label={label}
            className="relative flex h-28 items-end gap-px pb-2 pt-3"
          >
            <div className="pointer-events-none absolute inset-x-0 bottom-2 top-3">
              {[0, 1, 2, 3].map((tick) => (
                <div
                  key={tick}
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 border-t border-border/50"
                  style={{ bottom: `${(tick / 3) * 100}%` }}
                />
              ))}
            </div>
            {points.map((p, index) => {
              const text = `${dayLabel(p.date)}: ${p.valueText}`;
              const height =
                p.value > 0 ? Math.max(2, (p.value / axisMax) * 92) : 0;
              return (
                <div
                  key={p.date}
                  role="listitem"
                  tabIndex={0}
                  aria-label={text}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseLeave={() => setActiveIndex(null)}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex(null)}
                  className={cn(
                    'relative z-10 flex h-full min-w-0 flex-1 items-end outline-none focus-visible:ring-1 focus-visible:ring-primary',
                    activeIndex === index && 'bg-muted/60',
                  )}
                >
                  {p.value > 0 && (
                    <div
                      data-testid="day-bar"
                      className={cn(
                        'w-full max-w-full bg-primary/80',
                        activeIndex === index && 'bg-primary',
                      )}
                      style={{
                        height: `${height}px`,
                        borderRadius: Math.min(2, height / 2),
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {activeIndex !== null && points[activeIndex] && (
            <div
              className={cn(
                'pointer-events-none absolute inset-x-0 top-1 z-20 flex',
                (activeIndex + 0.5) / points.length < 0.3
                  ? 'justify-start'
                  : (activeIndex + 0.5) / points.length > 0.7
                    ? 'justify-end'
                    : 'justify-center',
              )}
            >
              <div
                role="tooltip"
                className="max-w-full break-words rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
              >
                <div>{dayLabel(points[activeIndex].date)}</div>
                <div className="font-medium tabular-nums">
                  {points[activeIndex].valueText}
                </div>
              </div>
            </div>
          )}
          <div
            aria-label="Date axis"
            className="relative mt-1 h-4 text-[10px] text-muted-foreground"
          >
            {dateTickIndexes(points.length).map((index) => (
              <span
                key={index}
                className={cn(
                  'absolute whitespace-nowrap',
                  index === 0
                    ? 'left-0'
                    : index === points.length - 1
                      ? 'right-0'
                      : '-translate-x-1/2',
                )}
                style={
                  index > 0 && index < points.length - 1
                    ? { left: `${((index + 0.5) / points.length) * 100}%` }
                    : undefined
                }
              >
                {formatShortDate(`${points[index].date}T00:00:00.000Z`)}
              </span>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface BreakdownRow {
  key: string;
  label: ReactNode;
  labelText?: string;
  value: number;
  valueText: string;
  tooltipValueText?: string;
  /** Extra text after the value, such as a box count. */
  detail?: string;
}

/** Horizontal bars, each against the largest value in the list. */
export function BreakdownBars({
  rows,
  label,
  className,
}: {
  rows: BreakdownRow[];
  label: string;
  className?: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <ul aria-label={label} className={cn('space-y-1.5', className)}>
        {rows.map((row) => {
          const width =
            max > 0
              ? Math.max(row.value > 0 ? 1 : 0, (row.value / max) * 100)
              : 0;
          const text = row.detail
            ? `${row.valueText}, ${row.detail}`
            : row.valueText;
          const tooltipText = row.tooltipValueText ?? row.valueText;
          const rowLabel =
            row.labelText ??
            (typeof row.label === 'string' ? row.label : row.key);
          return (
            <li key={row.key} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {text}
                </span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    tabIndex={0}
                    aria-label={`${rowLabel}: ${tooltipText}`}
                    className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
                  >
                    <div
                      className="h-full rounded-full bg-primary/80"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {rowLabel}: {tooltipText}
                </TooltipContent>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </TooltipProvider>
  );
}

export function StatTile({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="rounded-md border bg-background px-3 py-2"
      data-testid={testId}
    >
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-[15px] font-semibold tabular-nums">{value}</p>
      {detail && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
      )}
    </div>
  );
}

export function SubTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}
