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

const compactValue = (value: number) =>
  new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
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

/** A figure with its label. Wraps on a phone: the value never sets the width. */
export function Stat({
  label,
  value,
  hint,
  dataAttr,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  dataAttr?: string;
}) {
  return (
    <div
      className="min-w-0 rounded-md border bg-background/40 p-3"
      data-attr={dataAttr}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-lg font-semibold tabular-nums">
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 break-words text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function StatGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-2 gap-2 lg:grid-cols-4', className)}>
      {children}
    </div>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h4>
  );
}

/**
 * One bar per UTC day. Bars shrink to fit the card, so a year of days still
 * fits a phone without a horizontal scroll.
 */
export function DayBars({
  label,
  days,
  formatValue = compactValue,
  dataAttr,
}: {
  label: string;
  days: readonly { date: string; value: number }[];
  formatValue?: (value: number) => string;
  dataAttr?: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  if (days.length === 0) return null;
  const max = Math.max(0, ...days.map((d) => d.value));
  const step = axisStep(max);
  const axisMax = step * 3;
  return (
    <figure className="min-w-0" data-attr={dataAttr}>
      <figcaption className="mb-2 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">Peak {formatValue(max)}</span>
      </figcaption>
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
            role="group"
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
            {days.map((day, index) => {
              const text = `${dayLabel(day.date)}: ${formatValue(day.value)}`;
              const height =
                day.value > 0 ? Math.max(2, (day.value / axisMax) * 92) : 0;
              return (
                <div
                  key={day.date}
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
                  {day.value > 0 && (
                    <div
                      role="img"
                      aria-label={text}
                      data-testid="day-bar"
                      className={cn(
                        'w-full max-w-full bg-primary',
                        activeIndex === index && 'bg-primary/80',
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
          {activeIndex !== null && days[activeIndex] && (
            <div
              className={cn(
                'pointer-events-none absolute inset-x-0 top-1 z-20 flex',
                (activeIndex + 0.5) / days.length < 0.3
                  ? 'justify-start'
                  : (activeIndex + 0.5) / days.length > 0.7
                    ? 'justify-end'
                    : 'justify-center',
              )}
            >
              <div
                role="tooltip"
                className="max-w-full break-words rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
              >
                <div>{dayLabel(days[activeIndex].date)}</div>
                <div className="font-medium tabular-nums">
                  {formatValue(days[activeIndex].value)}
                </div>
              </div>
            </div>
          )}
          <div
            aria-label="Date axis"
            className="relative mt-1 h-4 text-[10px] text-muted-foreground"
          >
            {dateTickIndexes(days.length).map((index) => (
              <span
                key={index}
                className={cn(
                  'absolute whitespace-nowrap',
                  index === 0
                    ? 'left-0'
                    : index === days.length - 1
                      ? 'right-0'
                      : '-translate-x-1/2',
                )}
                style={
                  index > 0 && index < days.length - 1
                    ? { left: `${((index + 0.5) / days.length) * 100}%` }
                    : undefined
                }
              >
                {formatShortDate(`${days[index].date}T00:00:00Z`)}
              </span>
              ))}
          </div>
        </div>
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
  tooltipValueText?: string;
  detail?: ReactNode;
}

/** Horizontal bars for a breakdown. Labels wrap; the bar sits under them. */
export function HBars({
  rows,
  label,
  dataAttr,
}: {
  rows: readonly HBarRow[];
  label: string;
  dataAttr?: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <ul className="space-y-2" aria-label={label} data-attr={dataAttr}>
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 break-words">{row.label}</span>
              <span className="shrink-0 tabular-nums">{row.valueText}</span>
            </div>
            {row.detail && (
              <div className="break-words text-xs text-muted-foreground">
                {row.detail}
              </div>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  aria-label={`${row.labelText}: ${row.tooltipValueText ?? row.valueText}`}
                  className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
                >
                  <div
                    role="img"
                    aria-label={`${row.labelText}: ${row.valueText}`}
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${max > 0 ? (row.value / max) * 100 : 0}%`,
                    }}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="top">
                {row.labelText}: {row.tooltipValueText ?? row.valueText}
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
    </TooltipProvider>
  );
}
