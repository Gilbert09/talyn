import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Activity,
  Archive,
  ArrowRightLeft,
  Check,
  CircleHelp,
  CirclePause,
  ChevronRight,
  CircleX,
  Cloud,
  Laptop,
  Loader2,
  Moon,
  Snowflake,
  TriangleAlert,
} from 'lucide-react';
import {
  formatDurationMs,
  SANDBOX_SIZES,
  type SandboxSize,
  type SandboxStartInfo,
  type SandboxStartLayer,
  type SandboxStatusAction,
  type SandboxStatusState,
  type SandboxWorkSafety,
  type Workbench,
  type WorkbenchChat,
  type WorkbenchChatStatus,
  type WorkbenchSandboxStatus,
} from '@talyn/shared';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { captureWorkbenchFailure } from '../../lib/workbenchAnalytics';
import { useWorkbenchStore } from '../../stores/workbenches';
import { formatMib, SandboxUsageChart } from './SandboxUsageChart';

/** The backend caches its fleet read for 10 s, so a faster poll gets the same answer. */
const POLL_MS = 10_000;
const CHIP_POLL_MS = 30_000;

type StatusSnapshot = { status: WorkbenchSandboxStatus | null; error: string | null; at: number | null };
type StatusEntry = {
  snapshot: StatusSnapshot;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  seq: number;
};

const statusEntries = new Map<string, StatusEntry>();

function statusEntry(id: string): StatusEntry {
  let entry = statusEntries.get(id);
  if (!entry) {
    entry = {
      snapshot: { status: null, error: null, at: null },
      listeners: new Set(),
      inFlight: null,
      seq: 0,
    };
    statusEntries.set(id, entry);
  }
  return entry;
}

function subscribeToStatus(id: string, listener: () => void): () => void {
  const entry = statusEntry(id);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && !entry.inFlight && statusEntries.get(id) === entry) statusEntries.delete(id);
  };
}

function refreshStatus(id: string): Promise<void> {
  const entry = statusEntry(id);
  if (entry.inFlight) return entry.inFlight;
  const mine = ++entry.seq;
  const request = (async () => {
    try {
      const status = await api.workbenches.sandboxStatus(id);
      if (mine !== entry.seq || statusEntries.get(id) !== entry) return;
      entry.snapshot = { status, error: null, at: Date.now() };
    } catch (err) {
      if (mine !== entry.seq || statusEntries.get(id) !== entry) return;
      entry.snapshot = {
        ...entry.snapshot,
        error: err instanceof Error ? err.message : 'Could not read the sandbox status.',
        at: Date.now(),
      };
    }
    entry.listeners.forEach((listener) => listener());
  })();
  entry.inFlight = request;
  void request.finally(() => {
    if (entry.inFlight === request) {
      entry.inFlight = null;
      if (entry.listeners.size === 0 && statusEntries.get(id) === entry) statusEntries.delete(id);
    }
  });
  return request;
}

const STATE_ICON: Record<SandboxStatusState, { icon: typeof Cloud; className: string; spin?: boolean }> = {
  starting: { icon: Loader2, className: 'text-sky-500', spin: true },
  running: { icon: Activity, className: 'text-emerald-500' },
  idle: { icon: CirclePause, className: 'text-muted-foreground' },
  asleep: { icon: Moon, className: 'text-indigo-400' },
  hibernated: { icon: Snowflake, className: 'text-indigo-400' },
  waking: { icon: Loader2, className: 'text-sky-500', spin: true },
  moving: { icon: ArrowRightLeft, className: 'text-sky-500' },
  lost: { icon: TriangleAlert, className: 'text-amber-500' },
  failed: { icon: CircleX, className: 'text-destructive' },
  archived: { icon: Archive, className: 'text-muted-foreground' },
  local: { icon: Laptop, className: 'text-muted-foreground' },
  unknown: { icon: CircleHelp, className: 'text-muted-foreground' },
};

const RESTART_OUTCOME: Record<'after_turn' | 'restarting', string> = {
  after_turn: 'The restart starts when the current turn ends.',
  restarting: 'Talyn is moving the session to a fresh box.',
};

const RESIZE_OUTCOME: Record<'unchanged' | 'after_turn' | 'moving', string> = {
  unchanged: 'The session already has this size.',
  after_turn: 'The move starts when the current turn ends.',
  moving: 'Talyn is moving the session to the new box.',
};

/** A span of time in short words: "less than a minute", "12 min", "3 h", "2 d". */
export function formatSpan(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'less than a minute';
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function formatAgo(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  return ms < 60_000 ? 'just now' : `${formatSpan(ms)} ago`;
}

function sinceLine(status: WorkbenchSandboxStatus, now: number): string | null {
  if (!status.since) return null;
  const span = formatSpan(now - new Date(status.since).getTime());
  if (status.state === 'running' || status.state === 'idle') return `Up for ${span}`;
  if (status.state === 'asleep' || status.state === 'hibernated') return `Asleep for ${span}`;
  return null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** True when the chip needs a dot: the work may not be safe, or the box is gone. */
export function sandboxStatusNeedsAttention(status: WorkbenchSandboxStatus | null): 'warn' | 'danger' | null {
  if (!status) return null;
  if (status.state === 'failed') return 'danger';
  if (status.work?.warning) return status.work.warningLevel === 'danger' ? 'danger' : 'warn';
  if (status.state === 'lost') return 'warn';
  return null;
}

/** Shares status by session and polls every 10 s while the Sandbox tab is open. */
export function useSandboxStatus(workbench: Workbench, open: boolean, enabled = true) {
  const id = workbench.id;
  const subscribe = useCallback((listener: () => void) => subscribeToStatus(id, listener), [id]);
  const getSnapshot = useCallback(() => statusEntry(id).snapshot, [id]);
  const { status, error } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(() => enabled ? refreshStatus(id) : Promise.resolve(), [id, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh, workbench.status, workbench.sandboxState, workbench.updatedAt]);

  useEffect(() => {
    if (!open || !enabled) return undefined;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, enabled, refresh]);

  return { status: enabled ? status : null, error: enabled ? error : null, refresh };
}

/** A span as one short token for the chip: "6m", "2h", "3d". */
function shortSpan(ms: number): string {
  const min = Math.max(1, Math.round(Math.max(0, ms) / 60_000));
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export type ChipTone = 'running' | 'idle' | 'asleep' | 'busy' | 'lost' | 'failed';

const TONE_DOT: Record<ChipTone, string> = {
  running: 'bg-emerald-500',
  idle: 'bg-muted-foreground/60',
  asleep: 'bg-indigo-400',
  busy: 'bg-sky-500 animate-pulse',
  lost: 'bg-amber-500',
  failed: 'bg-destructive',
};

/**
 * The chip's word and dot colour. The detailed status wins when it has loaded;
 * until then the workbench row and the chat state give a good answer for free.
 * Null: nothing to say (no sandbox yet, or the session is archived).
 */
export function sandboxChipState(
  workbench: Pick<Workbench, 'status' | 'sandboxState'>,
  chatStatus: WorkbenchChatStatus | null | undefined,
  status: WorkbenchSandboxStatus | null,
  now = Date.now()
): { word: string; tone: ChipTone } | null {
  const turn = chatStatus === 'running';
  switch (status?.state) {
    case 'running':
      return { word: 'Running', tone: 'running' };
    case 'idle': {
      if (turn) return { word: 'Running', tone: 'running' };
      const left = status.sleepsAt ? new Date(status.sleepsAt).getTime() - now : null;
      return { word: left !== null && left > 0 ? `Idle · sleeps in ${shortSpan(left)}` : 'Idle', tone: 'idle' };
    }
    case 'asleep':
      return { word: 'Asleep', tone: 'asleep' };
    case 'hibernated':
      return { word: 'In storage', tone: 'asleep' };
    case 'waking':
      return { word: 'Waking', tone: 'busy' };
    case 'moving':
      return { word: 'Moving', tone: 'busy' };
    case 'starting':
      return { word: 'Starting', tone: 'busy' };
    case 'lost':
      return { word: 'Lost', tone: 'lost' };
    case 'failed':
      return { word: 'Failed', tone: 'failed' };
    default:
      break;
  }
  if (workbench.status === 'moving') return { word: 'Moving', tone: 'busy' };
  if (workbench.status === 'provisioning') return { word: 'Starting', tone: 'busy' };
  switch (workbench.sandboxState) {
    case 'creating':
      return { word: 'Starting', tone: 'busy' };
    case 'running':
      return turn ? { word: 'Running', tone: 'running' } : { word: 'Idle', tone: 'idle' };
    case 'suspended':
      return { word: 'Asleep', tone: 'asleep' };
    case 'lost':
      return { word: 'Lost', tone: 'lost' };
    case 'error':
      return { word: 'Failed', tone: 'failed' };
    default:
      return null;
  }
}

/** The Sandbox chip in the session header. It opens the Sandbox tab of the right panel. */
export function SandboxStatusChip({ workbench, chat }: { workbench: Workbench; chat?: WorkbenchChat | null }) {
  const setSideTab = useWorkbenchStore((s) => s.setSideTab);
  const { status, refresh } = useSandboxStatus(workbench, false);
  const attention = sandboxStatusNeedsAttention(status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => {
      setNow(Date.now());
      void refresh();
    };
    const timer = window.setInterval(update, CHIP_POLL_MS);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, [refresh]);
  const chip = sandboxChipState(workbench, chat?.status, status, now);

  return (
    <button
      type="button"
      onClick={() => setSideTab('sandbox')}
      className="app-region-no-drag inline-flex !max-w-48 shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      title="Sandbox status"
      data-attr="workbench-sandbox-chip"
    >
      <Cloud className="h-3 w-3 shrink-0" />
      {chip ? (
        <>
          <span
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[chip.tone])}
            data-testid="sandbox-chip-dot"
            data-tone={chip.tone}
            aria-hidden
          />
          <span className="truncate" data-testid="sandbox-chip-word">
            {chip.word}
          </span>
        </>
      ) : (
        'Sandbox'
      )}
      {attention && (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', attention === 'danger' ? 'bg-destructive' : 'bg-amber-500')}
          data-testid="sandbox-chip-warning"
          data-level={attention}
          aria-label="The sandbox needs attention"
        />
      )}
      <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
    </button>
  );
}

/**
 * The Sandbox tab of the right panel: the same content the popover had, as a
 * page. The panel owns the status hook, so the tab label can show a dot, and
 * the hook polls every 10 s while the tab is visible.
 */
export function SandboxTab({
  workbench,
  sandbox: { status, error, refresh },
}: {
  workbench: Workbench;
  sandbox: ReturnType<typeof useSandboxStatus>;
}) {
  return (
    <div className="h-full overflow-y-auto" data-testid="sandbox-tab">
      <SandboxStatusPanel workbench={workbench} status={status} error={error} onRefresh={refresh} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1 border-t px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function WorkSafety({ work, now }: { work: SandboxWorkSafety; now: number }) {
  const checkedNewer =
    work.checkedAt && (!work.savedAt || new Date(work.checkedAt).getTime() > new Date(work.savedAt).getTime());
  return (
    <ul className="space-y-0.5 text-xs" data-testid="sandbox-work">
      <li>{work.savedAt ? `Last checkpoint ${formatAgo(work.savedAt, now)}` : 'No checkpoint yet'}</li>
      {checkedNewer && work.checkedAt && <li>Checked {formatAgo(work.checkedAt, now)}: no new changes</li>}
      {work.uncommitted &&
        (work.uncommitted.files > 0 ? (
          <li>
            Not committed: {plural(work.uncommitted.files, 'file', 'files')},{' '}
            <span className="text-emerald-600 dark:text-emerald-400">+{work.uncommitted.added}</span>{' '}
            <span className="text-destructive">-{work.uncommitted.removed}</span>
          </li>
        ) : (
          <li>All changes are committed</li>
        ))}
      {work.unpushedCommits !== null && work.unpushedCommits > 0 ? (
        <li>{plural(work.unpushedCommits, 'commit', 'commits')} not on GitHub</li>
      ) : (
        work.branchPushed === true && <li>Branch is pushed</li>
      )}
      {work.failures > 0 && (
        <li className="text-destructive">
          {work.failures === 1 ? 'The last save failed' : `The last ${work.failures} saves failed`}
          {work.lastFailureAt ? ` (${formatAgo(work.lastFailureAt, now)})` : ''}
          {work.lastFailure ? `: ${work.lastFailure}` : ''}
        </li>
      )}
    </ul>
  );
}

const START_LAYER_SHORT: Record<SandboxStartLayer, string> = {
  user: 'your image',
  repo: 'repository image',
  legacy: 'older image',
  base: 'base image',
};

/** True when the backend sent anything for "How this box started". An older backend sends nothing. */
function hasStartFacts(start: SandboxStartInfo | null | undefined): start is SandboxStartInfo {
  if (!start) return false;
  return Boolean(start.image || start.timeline?.steps.length || start.lastWake || start.recent.length || start.comparison || start.note);
}

/** The image, the start timeline, the last wake and the repository's recent starts. */
function BoxStart({ start, now }: { start: SandboxStartInfo; now: number }) {
  const { image, timeline } = start;
  return (
    <div className="space-y-2 text-xs" data-testid="sandbox-start">
      {image && (
        <div className="space-y-0.5" data-testid="sandbox-start-image" data-layer={image.layer ?? 'unknown'}>
          <p>
            <span className="text-muted-foreground">Image: </span>
            <span className="font-medium">{image.label}</span>
          </p>
          <p className="text-muted-foreground">{image.detail}</p>
          {(image.repoCommit || image.builtAt) && (
            <p className="text-muted-foreground">
              {image.repoCommit && (
                <>
                  Commit <span className="font-mono">{image.repoCommit.slice(0, 7)}</span>
                </>
              )}
              {image.repoCommit && image.builtAt && ' · '}
              {image.builtAt && `Built ${formatAgo(image.builtAt, now)}`}
            </p>
          )}
          {image.pending && <p data-testid="sandbox-start-pending">{image.pending}</p>}
          {image.stale && <p>A newer image exists. A new box boots it.</p>}
        </div>
      )}
      {start.comparison && (
        <p
          data-testid="sandbox-start-comparison"
          data-slow={start.slow ? 'true' : 'false'}
          className={cn(start.slow ? 'flex items-start gap-1.5 text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}
        >
          {start.slow && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span>{start.comparison}</span>
        </p>
      )}
      {timeline && timeline.steps.length > 0 && (
        <ul className="space-y-0.5" data-testid="sandbox-start-timeline">
          {timeline.steps.map((step, i) => (
            <li
              key={`${step.kind}-${i}`}
              data-kind={step.kind}
              data-ok={step.ok === null ? 'unknown' : String(step.ok)}
              className={cn(
                'flex items-baseline justify-between gap-2',
                step.kind === 'setup_step' && 'pl-4',
                step.kind === 'ready' && 'border-t pt-0.5 font-medium',
                step.ok === false && 'text-destructive'
              )}
            >
              <span className="flex min-w-0 items-center gap-1">
                {step.ok === false && <CircleX className="h-3 w-3 shrink-0" aria-label="Failed" />}
                {step.ok === true && step.kind === 'setup_step' && (
                  <Check className="h-3 w-3 shrink-0 text-emerald-500" aria-label="Done" />
                )}
                <span className="truncate">{step.label}</span>
                {step.detail && <span className="shrink-0 text-muted-foreground">({step.detail})</span>}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {step.durationMs === null ? 'not measured' : formatDurationMs(step.durationMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {start.lastWake && (
        <p data-testid="sandbox-start-wake" className={cn(!start.lastWake.ok && 'text-destructive')}>
          {start.lastWake.text}
          <span className="text-muted-foreground"> · {formatAgo(start.lastWake.at, now)}</span>
        </p>
      )}
      {start.recent.length > 0 && (
        <div data-testid="sandbox-start-recent">
          <p className="text-muted-foreground">Recent starts of this repository</p>
          <ul className="space-y-0.5">
            {start.recent.map((r) => (
              <li key={`${r.at}-${r.totalMs}`} className="flex justify-between gap-2">
                <span className="text-muted-foreground">
                  {formatAgo(r.at, now)}
                  {r.layer ? ` · ${START_LAYER_SHORT[r.layer]}` : ''}
                  {r.thisSession ? ' · this session' : ''}
                </span>
                <span className="tabular-nums">{formatDurationMs(r.totalMs)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {start.note && (
        <p className="text-muted-foreground" data-testid="sandbox-start-note">
          {start.note}
        </p>
      )}
    </div>
  );
}

type Pending = { action: SandboxStatusAction; size?: SandboxSize };

/** What the sandbox is doing, in plain words. The backend writes the words. */
export function SandboxStatusPanel({
  workbench,
  status,
  error,
  onRefresh,
  onClose,
  onHoldOpen,
}: {
  workbench: Workbench;
  status: WorkbenchSandboxStatus | null;
  error: string | null;
  onRefresh: () => void | Promise<void>;
  onClose?: () => void;
  onHoldOpen?: (hold: boolean) => void;
}) {
  const [busy, setBusy] = useState<SandboxStatusAction['kind'] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = (next: Pending | null) => {
    setPending(next);
    onHoldOpen?.(next !== null);
  };

  if (!status) {
    return (
      <div className="p-3 text-xs" data-testid="sandbox-status-panel">
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Reading the sandbox status
          </p>
        )}
      </div>
    );
  }

  const now = Date.now();
  const state = STATE_ICON[status.state];
  const StateIcon = state.icon;
  const since = sinceLine(status, now);
  const work = status.work;

  const perform = async ({ action, size }: Pending) => {
    setBusy(action.kind);
    setActionError(null);
    setNote(null);
    try {
      if (action.kind === 'wake') {
        const answer = await api.workbenches.wake(workbench.id);
        if (answer.status === 'moving' || answer.status === 'resuming' || answer.status === 'awake') {
          trackEvent('session_sandbox_woken', { workbench_id: workbench.id, source: 'wake_button' });
        }
      } else if (action.kind === 'retry') {
        useWorkbenchStore.getState().upsertWorkbench(await api.workbenches.retry(workbench.id));
        trackEvent('session_retry', { workbench_id: workbench.id });
      }
      else if (action.kind === 'resize' && size) {
        const res = await api.workbenches.resize(workbench.id, { size });
        if (res.outcome !== 'unchanged') trackEvent('session_moved', { workbench_id: workbench.id, reason: 'size' });
        setNote(RESIZE_OUTCOME[res.outcome]);
        setPicking(false);
      }
      else if (action.kind === 'restart') {
        const res = await api.workbenches.restart(workbench.id);
        trackEvent('session_moved', { workbench_id: workbench.id, reason: 'restart' });
        setNote(RESTART_OUTCOME[res.outcome]);
      }
      await onRefresh();
    } catch (err) {
      captureWorkbenchFailure(`sandbox_${action.kind}`, err, workbench.id);
      setActionError(err instanceof Error ? err.message : `Could not ${action.label.toLowerCase()}.`);
    } finally {
      setBusy(null);
    }
  };

  const start = (next: Pending) => {
    if (next.action.confirm) ask(next);
    else void perform(next);
  };

  const press = (action: SandboxStatusAction) => {
    if (action.kind === 'show_setup_output') {
      useWorkbenchStore.getState().setTerminalTab('setup');
      onClose?.();
      return;
    }
    if (action.kind === 'resize') {
      setPicking((p) => !p);
      return;
    }
    start({ action });
  };

  const resizeAction = status.actions.find((a) => a.kind === 'resize');

  return (
    <div className="text-sm" data-testid="sandbox-status-panel" data-state={status.state}>
      <div className="space-y-1 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <StateIcon className={cn('mt-0.5 h-4 w-4 shrink-0', state.className, state.spin && 'animate-spin')} aria-hidden />
          <p className="font-medium leading-snug" data-testid="sandbox-headline">
            {status.headline}
          </p>
        </div>
        {status.detail && <p className="text-xs text-muted-foreground">{status.detail}</p>}
        {since && <p className="text-xs text-muted-foreground">{since}</p>}
        {!status.fleet.known && status.fleet.error && (
          <p className="text-[11px] text-muted-foreground" data-testid="sandbox-fleet-unknown">
            The fleet did not answer. Some facts are unknown.
          </p>
        )}
      </div>

      {work?.warning && (
        <div
          role="alert"
          data-testid="sandbox-work-warning"
          data-level={work.warningLevel ?? 'warn'}
          className={cn(
            'mx-3 mb-2 flex items-start gap-1.5 rounded border px-2 py-1.5 text-xs',
            work.warningLevel === 'danger'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          )}
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{work.warning}</span>
        </div>
      )}

      {(status.host || status.size) && (
        <Section title="Where">
          <ul className="space-y-0.5 text-xs">
            {status.host && <li>Host: <span className="font-mono">{status.host}</span></li>}
            {status.size && <li>Size: {status.size.label}</li>}
          </ul>
        </Section>
      )}

      {(status.resources || status.usage) && (
        <Section title="Resources">
          {status.usage && <SandboxUsageChart usage={status.usage} checkedAt={status.checkedAt} />}
          {status.resources && (
            <ul className={cn('space-y-0.5 text-xs', status.usage && 'pt-1')} data-testid="sandbox-resources">
              {status.usage ? null : status.resources.memoryUsedMib !== null ? (
                <li>
                  Memory: {formatMib(status.resources.memoryUsedMib)} used
                  {status.resources.memoryLimitMib !== null && ` of ${formatMib(status.resources.memoryLimitMib)}`}
                </li>
              ) : status.resources.memoryLimitMib !== null ? (
                <li>Memory limit: {formatMib(status.resources.memoryLimitMib)}</li>
              ) : null}
              {status.resources.vcpus !== null && (
                <li>CPU: {status.resources.vcpus} vCPU{status.resources.vcpus === 1 ? '' : 's'} allocated</li>
              )}
              {status.resources.diskMib !== null && <li>Disk capacity: {formatMib(status.resources.diskMib)}</li>}
            </ul>
          )}
        </Section>
      )}

      <Section title="Doing">
        {status.activity.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing is running.</p>
        ) : (
          <ul className="space-y-0.5 text-xs" data-testid="sandbox-activity">
            {status.activity.map((a, i) => (
              <li key={`${a.kind}-${a.chatId ?? a.name ?? i}`}>
                {a.text}
                {a.since && <span className="text-muted-foreground"> · {formatSpan(now - new Date(a.since).getTime())}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {work && (
        <Section title="Work">
          <WorkSafety work={work} now={now} />
        </Section>
      )}

      {hasStartFacts(status.start) && (
        <Section title="How this box started">
          <BoxStart start={status.start} now={now} />
        </Section>
      )}

      {status.problem && (
        <Section title="Last problem">
          <p className="text-xs" data-testid="sandbox-problem">
            {status.problem.text}
            {status.problem.at && <span className="text-muted-foreground"> · {formatAgo(status.problem.at, now)}</span>}
          </p>
        </Section>
      )}

      {(status.actions.length > 0 || actionError || note) && (
        <div className="space-y-2 border-t px-3 py-2">
          {status.actions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {status.actions.map((action) => (
                <Button
                  key={action.kind}
                  variant="outline"
                  className="h-7 gap-1.5 px-2.5 text-xs"
                  disabled={busy !== null}
                  aria-expanded={action.kind === 'resize' ? picking : undefined}
                  onClick={() => press(action)}
                  data-attr={`sandbox-action-${action.kind}`}
                >
                  {busy === action.kind && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {action.label}
                </Button>
              ))}
            </div>
          )}
          {picking && resizeAction && (
            <ul className="space-y-1" data-testid="sandbox-size-picker">
              {(Object.keys(SANDBOX_SIZES) as SandboxSize[]).map((size) => {
                const current = status.size?.key === size;
                return (
                  <li key={size}>
                    <button
                      type="button"
                      disabled={current || busy !== null}
                      onClick={() => start({ action: resizeAction, size })}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left text-xs hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent',
                        current && 'border-primary/50 bg-primary/5'
                      )}
                      data-attr={`sandbox-size-${size}`}
                    >
                      <span>
                        <span className="font-medium">{SANDBOX_SIZES[size].label}</span>
                        <span className="text-muted-foreground"> · {SANDBOX_SIZES[size].hint}</span>
                      </span>
                      {current && <span className="shrink-0 text-[10px] text-muted-foreground">Current</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
          {actionError && (
            <p className="text-xs text-destructive" role="alert">
              {actionError}
            </p>
          )}
        </div>
      )}

      {error && <p className="border-t px-3 py-1.5 text-[11px] text-destructive">{error}</p>}

      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${pending.action.label}?` : ''}
        description={pending?.action.confirm ?? undefined}
        confirmLabel={pending?.action.label ?? 'Confirm'}
        busy={busy !== null}
        onConfirm={() => {
          const next = pending;
          ask(null);
          if (next) void perform(next);
        }}
        onCancel={() => ask(null)}
      />
    </div>
  );
}
