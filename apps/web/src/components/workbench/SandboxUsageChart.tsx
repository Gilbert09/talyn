import { useState, type MouseEvent } from 'react';
import type { SandboxUsageHistory, SandboxUsagePoint } from '@talyn/shared';
import { cn } from '../../lib/utils';

/** The chart's own units. The SVG scales evenly to the panel's width. */
const WIDTH = 300;
const HEIGHT = 52;
/** A step this many times longer than the normal one is a gap in the line. */
const GAP_STEPS = 2.5;

export function formatMib(mib: number): string {
  if (mib < 1024) return `${Math.round(mib)} MB`;
  const gib = mib / 1024;
  return `${Number(gib.toFixed(1))} GB`;
}

function formatPercent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function minutesAgo(at: number, now: number): string {
  const min = Math.round((now - at) / 60_000);
  return min < 1 ? 'now' : `${min} min ago`;
}

type Domain = { start: number; end: number; stepMs: number };
type Plotted = { x: number; y: number; at: number };

/** The points with a value, in chart units, split where the line has a gap. */
export function usageSegments(
  points: SandboxUsagePoint[],
  value: (p: SandboxUsagePoint) => number | null,
  max: number,
  domain: Domain
): Plotted[][] {
  const span = Math.max(1, domain.end - domain.start);
  const out: Plotted[][] = [];
  let current: Plotted[] = [];
  let lastAt: number | null = null;
  for (const p of points) {
    const v = value(p);
    const at = new Date(p.at).getTime();
    if (v === null || (lastAt !== null && at - lastAt > domain.stepMs * GAP_STEPS)) {
      if (current.length) out.push(current);
      current = [];
    }
    if (v !== null) {
      const x = ((at - domain.start) / span) * WIDTH;
      const y = HEIGHT - (Math.min(Math.max(v, 0), max) / max) * HEIGHT;
      current.push({ x: Math.min(WIDTH, Math.max(0, x)), y, at });
    }
    lastAt = at;
  }
  if (current.length) out.push(current);
  return out;
}

function nearestIndex(points: SandboxUsagePoint[], at: number): number | null {
  let best: number | null = null;
  let bestGap = Infinity;
  points.forEach((p, i) => {
    const gap = Math.abs(new Date(p.at).getTime() - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  });
  return best;
}

type SeriesSpec = {
  key: 'cpu' | 'memory';
  title: string;
  /** The line and hover dot. Text stays in the text colours. */
  stroke: string;
  /** The key swatch beside the title, in the same colour. */
  swatch: string;
  max: number;
  maxLabel: string;
  value: (p: SandboxUsagePoint) => number | null;
  format: (v: number) => string;
};

function UsageLine({
  spec,
  points,
  domain,
  hover,
  onHover,
  empty,
}: {
  spec: SeriesSpec;
  points: SandboxUsagePoint[];
  domain: Domain;
  hover: number | null;
  onHover: (index: number | null) => void;
  empty: string | null;
}) {
  const segments = usageSegments(points, spec.value, spec.max, domain);
  const shown = hover !== null ? points[hover] : [...points].reverse().find((p) => spec.value(p) !== null);
  const shownValue = shown ? spec.value(shown) : null;
  const hoverX = hover !== null ? ((new Date(points[hover].at).getTime() - domain.start) / Math.max(1, domain.end - domain.start)) * WIDTH : null;
  const hoverY = hoverX !== null && shownValue !== null ? HEIGHT - (Math.min(Math.max(shownValue, 0), spec.max) / spec.max) * HEIGHT : null;

  const move = (e: MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    onHover(nearestIndex(points, domain.start + fraction * (domain.end - domain.start)));
  };

  return (
    <div className="space-y-0.5" data-testid={`sandbox-usage-${spec.key}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5">
          <span className={cn('h-0.5 w-3 rounded-full', spec.swatch)} aria-hidden />
          {spec.title}
        </span>
        <span className="tabular-nums" data-testid={`sandbox-usage-${spec.key}-value`}>
          {shownValue !== null ? spec.format(shownValue) : '—'}
          {hover !== null && shown && (
            <span className="text-muted-foreground"> · {minutesAgo(new Date(shown.at).getTime(), domain.end)}</span>
          )}
        </span>
      </div>
      {empty ? (
        <p className="text-[11px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="block h-auto w-full overflow-visible"
            role="img"
            aria-label={`${spec.title} over the last ${Math.round((domain.end - domain.start) / 60_000)} minutes${shownValue !== null ? `, now ${spec.format(shownValue)}` : ''}`}
            onMouseMove={move}
            onMouseLeave={() => onHover(null)}
          >
            <line x1={0} x2={WIDTH} y1={0.5} y2={0.5} className="stroke-border" strokeDasharray="2 3" strokeWidth={1} />
            <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-border" strokeWidth={1} />
            {segments.map((seg, i) =>
              seg.length === 1 ? (
                <circle key={i} cx={seg[0].x} cy={seg[0].y} r={1.5} className={cn(spec.stroke, 'fill-current')} />
              ) : (
                <polyline
                  key={i}
                  points={seg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
                  fill="none"
                  className={spec.stroke}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )
            )}
            {hoverX !== null && (
              <line x1={hoverX} x2={hoverX} y1={0} y2={HEIGHT} className="stroke-muted-foreground/50" strokeWidth={1} />
            )}
            {hoverX !== null && hoverY !== null && (
              <circle cx={hoverX} cy={hoverY} r={3} className={cn(spec.stroke, 'fill-background')} strokeWidth={1.5} />
            )}
          </svg>
          <span className="pointer-events-none absolute left-0.5 top-0.5 text-[9px] leading-none text-muted-foreground">
            {spec.maxLabel}
          </span>
        </div>
      )}
    </div>
  );
}

/** CPU and memory over the last hour, one chart each so each has its own scale. */
export function SandboxUsageChart({ usage, checkedAt }: { usage: SandboxUsageHistory; checkedAt: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const end = new Date(checkedAt).getTime();
  const domain: Domain = { start: end - usage.windowMinutes * 60_000, end, stepMs: usage.stepSeconds * 1000 };
  const { points } = usage;
  const peakMemory = Math.max(0, ...points.map((p) => p.memoryUsedMib ?? 0));
  const memoryMax = usage.memoryLimitMib ?? Math.max(1, peakMemory * 1.2);
  const hasCpu = points.some((p) => p.cpuPercent !== null);
  const hasMemory = points.some((p) => p.memoryUsedMib !== null);

  const cpu: SeriesSpec = {
    key: 'cpu',
    title: 'CPU',
    stroke: 'stroke-sky-500',
    swatch: 'bg-sky-500',
    max: 100,
    maxLabel: '100%',
    value: (p) => p.cpuPercent,
    format: formatPercent,
  };
  const memory: SeriesSpec = {
    key: 'memory',
    title: 'Memory',
    stroke: 'stroke-violet-500',
    swatch: 'bg-violet-500',
    max: memoryMax,
    maxLabel: usage.memoryLimitMib !== null ? `${formatMib(usage.memoryLimitMib)} limit` : formatMib(memoryMax),
    value: (p) => p.memoryUsedMib,
    format: (v) => (usage.memoryLimitMib ? `${formatMib(v)} of ${formatMib(usage.memoryLimitMib)}` : formatMib(v)),
  };

  return (
    <div className="space-y-2" data-testid="sandbox-usage">
      <UsageLine
        spec={cpu}
        points={points}
        domain={domain}
        hover={hover}
        onHover={setHover}
        empty={
          !usage.cpuReported
            ? 'The fleet does not report CPU use for this box yet.'
            : hasCpu
              ? null
              : 'CPU use shows after two samples, about two minutes.'
        }
      />
      <UsageLine
        spec={memory}
        points={points}
        domain={domain}
        hover={hover}
        onHover={setHover}
        empty={hasMemory ? null : 'The fleet does not report memory use for this box.'}
      />
      <div className="flex justify-between text-[10px] text-muted-foreground" aria-hidden>
        <span>{usage.windowMinutes} min ago</span>
        <span>Now</span>
      </div>
    </div>
  );
}
