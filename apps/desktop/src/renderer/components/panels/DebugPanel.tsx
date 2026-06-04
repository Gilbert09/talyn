import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug, Trash2, Pause, Play, Wifi, Info } from 'lucide-react';
import type { DebugCategory, DebugEvent, DebugSnapshot } from '@fastowl/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

// Keep the rendered list bounded — the backend ring buffer caps at 1000, and
// the DOM stays cheap if we render the most recent slice.
const MAX_RENDERED = 500;
// How often we re-pull the snapshot (poller "last tick" ages, client count).
const SNAPSHOT_INTERVAL_MS = 3_000;

type CategoryFilter = 'all' | DebugCategory;

const CATEGORY_LABEL: Record<DebugCategory, string> = {
  http: 'HTTP',
  polling: 'Polling',
  websocket: 'WebSocket',
  event: 'Events',
  error: 'Errors',
};

const FILTERS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'http', label: 'HTTP' },
  { id: 'polling', label: 'Polling' },
  { id: 'websocket', label: 'WebSocket' },
  { id: 'event', label: 'Events' },
  { id: 'error', label: 'Errors' },
];

// What each event category means. Surfaced as tooltips on the counter chips
// and the legend. Keep this in sync when adding a new DebugCategory.
const CATEGORY_INFO: Record<DebugCategory, string> = {
  http: 'Outbound HTTP to external services (GitHub REST/GraphQL, PostHog Code). Metadata only — method, URL with the query stripped, status, and duration.',
  polling: 'Background poll-loop ticks. Each loop wakes on its own interval to reconcile state — see the cards above for what each does.',
  websocket: 'The realtime channel to the desktop app: client connect/disconnect, inbound messages, and outbound broadcasts.',
  event: 'In-process domain events (e.g. a task changing status) that other backend services react to.',
  error: 'A request or poll tick that failed — expand the row for the error message.',
};

// What each non-poller service is. Pollers carry their own description from
// the backend registry; these cover the services that show up in HTTP/event
// rows. Keep this in sync when a new outbound integration or emitter lands.
const SERVICE_INFO: Record<string, string> = {
  github: 'GitHub REST + GraphQL API — PR data, checks, reviews, merges, and OAuth.',
  posthog_code: 'PostHog Code cloud-task API — creates and runs cloud agent tasks and streams their transcripts.',
  ws: 'The WebSocket server fanning realtime updates out to connected desktop clients.',
  tasks: 'Task lifecycle domain events (queued → in_progress → completed/failed).',
};

const TIP_WIDTH = 256; // matches w-64
const TIP_MARGIN = 8; // min gap from the viewport edge

/**
 * Dependency-free hover tooltip. Renders into a body portal with fixed
 * positioning clamped to the viewport, so it can't be clipped by the panel's
 * overflow container or slide under the sidebar (which a plain absolutely-
 * positioned tooltip does for left-edge triggers).
 */
function Tip({
  content,
  children,
  className,
  side = 'top',
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  side?: 'top' | 'bottom';
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Centre on the trigger, then clamp so the box stays fully on-screen.
    const left = Math.max(
      TIP_MARGIN,
      Math.min(
        r.left + r.width / 2 - TIP_WIDTH / 2,
        window.innerWidth - TIP_WIDTH - TIP_MARGIN
      )
    );
    const top = side === 'top' ? r.top : r.bottom;
    setCoords({ top, left });
  }, [side]);

  const hide = useCallback(() => setCoords(null), []);

  return (
    <span
      ref={triggerRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {coords &&
        createPortal(
          <span
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              transform:
                side === 'top'
                  ? 'translateY(calc(-100% - 6px))'
                  : 'translateY(6px)',
            }}
            className="pointer-events-none z-[100] block w-64 max-w-[80vw] whitespace-normal rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-left text-[11px] font-normal normal-case leading-relaxed text-zinc-300 shadow-lg"
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  );
}

/** Tailwind classes for the per-category badge in the stream. */
function categoryClasses(category: DebugCategory): string {
  switch (category) {
    case 'http':
      return 'bg-sky-500/15 text-sky-300';
    case 'polling':
      return 'bg-violet-500/15 text-violet-300';
    case 'websocket':
      return 'bg-emerald-500/15 text-emerald-300';
    case 'event':
      return 'bg-amber-500/15 text-amber-300';
    case 'error':
      return 'bg-red-500/15 text-red-300';
  }
}

function timeOf(ts: string): string {
  // HH:MM:SS.mmm — precise enough to read interleaving without a date.
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 0) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

export function DebugPanel() {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [serviceFilter, setServiceFilter] = useState<string>('');
  const [paused, setPaused] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Incoming live events are buffered in a ref and flushed once per animation
  // frame, so a burst of activity can't trigger a render per event.
  const pendingRef = useRef<DebugEvent[]>([]);
  const rafRef = useRef<number | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const flush = useCallback(() => {
    rafRef.current = null;
    if (pendingRef.current.length === 0) return;
    const incoming = pendingRef.current;
    pendingRef.current = [];
    setEvents((prev) => {
      // Newest first; cap the list. Incoming arrives in chronological order.
      const next = [...incoming.reverse(), ...prev];
      return next.length > MAX_RENDERED ? next.slice(0, MAX_RENDERED) : next;
    });
  }, []);

  const refreshSnapshot = useCallback(() => {
    api.debug.getSnapshot().then(setSnapshot).catch(() => {});
  }, []);

  // Backfill + live subscription. The backend pushes every debug event over
  // the existing WebSocket as `debug:event`.
  useEffect(() => {
    let cancelled = false;
    api.debug
      .getEvents({ limit: MAX_RENDERED })
      .then((backfill) => {
        if (cancelled) return;
        // getEvents returns chronological order — show newest first.
        setEvents([...backfill].reverse());
      })
      .catch(() => {});
    refreshSnapshot();

    const off = api.ws.on<DebugEvent>('debug:event', (event) => {
      if (pausedRef.current) return;
      pendingRef.current.push(event);
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flush);
      }
    });

    const snapTimer = window.setInterval(refreshSnapshot, SNAPSHOT_INTERVAL_MS);

    return () => {
      cancelled = true;
      off();
      window.clearInterval(snapTimer);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [flush, refreshSnapshot]);

  const handleClear = useCallback(() => {
    api.debug.clearEvents().catch(() => {});
    setEvents([]);
    pendingRef.current = [];
    refreshSnapshot();
  }, [refreshSnapshot]);

  const visible = useMemo(() => {
    const svc = serviceFilter.trim().toLowerCase();
    return events.filter((e) => {
      if (filter !== 'all' && e.category !== filter) return false;
      if (svc && !e.service.toLowerCase().includes(svc)) return false;
      return true;
    });
  }, [events, filter, serviceFilter]);

  return (
    <div className="flex h-full flex-col bg-[#0f0f10] text-zinc-100">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bug className="h-5 w-5 text-zinc-400" />
          <h2 className="text-base font-semibold">Debug</h2>
          <span className="text-xs text-zinc-500">app internals, live</span>
          <Tip
            side="bottom"
            content={
              <span className="block space-y-1.5">
                {(Object.keys(CATEGORY_INFO) as DebugCategory[]).map((c) => (
                  <span key={c} className="block">
                    <span className="font-medium text-zinc-100">{CATEGORY_LABEL[c]}</span>
                    {' — '}
                    {CATEGORY_INFO[c]}
                  </span>
                ))}
              </span>
            }
          >
            <Info className="h-3.5 w-3.5 text-zinc-600 hover:text-zinc-400" />
          </Tip>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-zinc-300 hover:text-zinc-100"
            onClick={() => setPaused((p) => !p)}
            title={paused ? 'Resume live stream' : 'Pause live stream'}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-zinc-300 hover:text-zinc-100"
            onClick={handleClear}
            title="Clear the buffer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </div>

      {/* Snapshot bar */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Tip
            side="bottom"
            content="Desktop clients currently connected to the backend's WebSocket. The debug stream you're watching is one of them."
          >
            <span className="flex items-center gap-1.5 rounded-md bg-zinc-800/60 px-2.5 py-1 text-xs text-zinc-300">
              <Wifi className="h-3.5 w-3.5 text-emerald-400" />
              {snapshot?.wsClients ?? 0} WS client{snapshot?.wsClients === 1 ? '' : 's'}
            </span>
          </Tip>
          {snapshot &&
            Object.entries(snapshot.counters).map(([cat, n]) => (
              <Tip
                key={cat}
                side="bottom"
                content={CATEGORY_INFO[cat as DebugCategory] ?? 'Recorded events in this category since the last clear.'}
              >
                <span
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs',
                    categoryClasses(cat as DebugCategory)
                  )}
                >
                  {CATEGORY_LABEL[cat as DebugCategory] ?? cat}: {n}
                </span>
              </Tip>
            ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {(snapshot?.pollers ?? []).map((p) => (
            <div
              key={p.name}
              className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2"
            >
              <div className="flex items-center justify-between gap-2">
                <Tip
                  side="bottom"
                  className="min-w-0"
                  content={
                    <span className="block">
                      <span className="font-mono font-medium text-zinc-100">{p.name}</span>
                      <span className="mt-1 block">
                        {p.description || SERVICE_INFO[p.name] || 'A background poll loop.'}
                      </span>
                      <span className="mt-1 block text-zinc-500">
                        Runs every {Math.round(p.intervalMs / 1000)}s.
                      </span>
                    </span>
                  }
                >
                  <span className="flex items-center gap-1 truncate font-mono text-xs text-zinc-200">
                    {p.name}
                    <Info className="h-3 w-3 shrink-0 text-zinc-600" />
                  </span>
                </Tip>
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    p.lastOk === false
                      ? 'bg-red-500'
                      : p.lastTickAt
                        ? 'bg-emerald-500'
                        : 'bg-zinc-600'
                  )}
                  title={p.lastError ?? (p.lastOk === false ? 'last tick failed' : 'ok')}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
                <span>every {Math.round(p.intervalMs / 1000)}s</span>
                <span>{ago(p.lastTickAt)}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[11px] text-zinc-500">
                <span>{p.tickCount} ticks</span>
                {p.lastDurationMs != null && <span>{p.lastDurationMs}ms</span>}
              </div>
              {p.lastError && (
                <p className="mt-1 truncate text-[11px] text-red-400" title={p.lastError}>
                  {p.lastError}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                filter === f.id
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={serviceFilter}
          onChange={(e) => setServiceFilter(e.target.value)}
          placeholder="filter by service…"
          className="ml-auto w-44 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
        />
        <span className="text-xs text-zinc-600">{visible.length}</span>
      </div>

      {/* Event stream */}
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-600">
            {paused ? 'Paused — no new events captured.' : 'Waiting for activity…'}
          </div>
        ) : (
          visible.map((e) => {
            const expanded = expandedId === e.id;
            const hasMeta = e.meta && Object.keys(e.meta).length > 0;
            return (
              <div key={e.id} className="border-b border-zinc-900">
                <button
                  onClick={() => setExpandedId(expanded ? null : e.id)}
                  className="flex w-full items-start gap-2 px-4 py-1.5 text-left hover:bg-zinc-900/60"
                >
                  <span className="shrink-0 text-zinc-600">{timeOf(e.timestamp)}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 text-[10px] uppercase leading-5',
                      categoryClasses(e.category)
                    )}
                  >
                    {CATEGORY_LABEL[e.category]}
                  </span>
                  <span className="shrink-0 text-zinc-500" title={SERVICE_INFO[e.service]}>
                    {e.service}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      e.ok ? 'text-zinc-200' : 'text-red-400'
                    )}
                  >
                    {e.summary}
                  </span>
                  {e.durationMs != null && (
                    <span className="shrink-0 text-zinc-600">{Math.round(e.durationMs)}ms</span>
                  )}
                </button>
                {expanded && hasMeta && (
                  <pre className="overflow-x-auto bg-zinc-950 px-4 py-2 text-[11px] text-zinc-400">
                    {JSON.stringify(e.meta, null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
