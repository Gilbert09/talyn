import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MAX_LIVE_MEMORIES_PER_WORKSPACE,
  MEMORY_REVIEW_CADENCES,
  MEMORY_REVIEW_CADENCE_LABELS,
  memoryLimitMessage,
  memoryReviewCadenceOf,
  type MemoryReviewCadence,
  type MemoryReviewRun,
  type MemoryEntry,
  type MemoryEntrySummary,
  type Workspace,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useNavigationStore } from '../../stores/navigation';
import { toast } from '../../stores/toast';
import { useWorkspaceStore } from '../../stores/workspace';
import { MemoryEditor, MemorySourceLabel, MemoryTypeChip, memoryScopeLabel } from '../memory/MemoryEditor';
import { Button } from '../ui/button';
import { SettingRow, SettingsSection } from '../ui/settings';

const INTRO = 'Notes that sessions read before they work. A session sees the workspace notes and the notes of its repository.';
const EMPTY = 'Sessions save notes here as they learn about your work. You can add your own too.';
const SEARCH_DELAY_MS = 250;

/** "3d ago": coarse on purpose; the title carries the exact time. */
function ago(iso: string, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`;
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/** `settings.sessionMemory`: on unless set to false. */
function SessionMemorySwitch({ workspaceId }: { workspaceId: string }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);
  const enabled = workspaces.find((w) => w.id === workspaceId)?.settings?.sessionMemory !== false;

  const onChange = async (value: boolean) => {
    setSaving(true);
    try {
      await api.workspaces.update(workspaceId, { settings: { sessionMemory: value } as Workspace['settings'] });
      setWorkspaces(
        useWorkspaceStore
          .getState()
          .workspaces.map((w) =>
            w.id === workspaceId ? { ...w, settings: { ...w.settings, sessionMemory: value } as Workspace['settings'] } : w,
          ),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save this setting');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      label="Session memory"
      description="Sessions read these notes and save new ones. When it is off, sessions do not use memory. You can still edit the notes here."
    >
      <Switch checked={enabled} disabled={saving} label="Session memory" onChange={(v) => void onChange(v)} />
    </SettingRow>
  );
}

function runLine(run: MemoryReviewRun | undefined, openThread: (id: string) => void): React.ReactNode {
  if (!run) return null;
  if (run.status === 'failed') return `Last review failed: ${run.error ?? 'unknown error'}`;
  if (run.status === 'starting') return 'A review is starting';
  return (
    <>
      Last review: <span title={new Date(run.createdAt).toLocaleString()}>{ago(run.createdAt)}</span>
      {run.workbenchId ? (
        <>
          {' · '}
          <button
            type="button"
            className="underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => openThread(run.workbenchId!)}
          >
            Open thread
          </button>
        </>
      ) : null}
    </>
  );
}

/** `settings.memoryReview`: how often Talyn reviews the notes. */
function MemoryReviewRow({ workspaceId }: { workspaceId: string }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runs, setRuns] = useState<MemoryReviewRun[]>([]);
  const settings = workspaces.find((w) => w.id === workspaceId)?.settings;
  const cadence = memoryReviewCadenceOf(settings);
  const memoryOff = settings?.sessionMemory === false;

  const refresh = useCallback(async () => {
    try {
      setRuns((await api.workbenches.memory.reviews(workspaceId)).runs);
    } catch {
      setRuns([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onChange = async (value: MemoryReviewCadence) => {
    setSaving(true);
    try {
      await api.workspaces.update(workspaceId, { settings: { memoryReview: value } as Workspace['settings'] });
      setWorkspaces(
        useWorkspaceStore
          .getState()
          .workspaces.map((w) =>
            w.id === workspaceId ? { ...w, settings: { ...w.settings, memoryReview: value } as Workspace['settings'] } : w,
          ),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save this setting');
    } finally {
      setSaving(false);
    }
  };

  const reviewNow = async () => {
    setStarting(true);
    try {
      await api.workbenches.memory.startReview(workspaceId);
      toast.success('Memory review started');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start a memory review');
    } finally {
      setStarting(false);
    }
  };

  const line = runLine(runs[0], (id) => useNavigationStore.getState().navigate({ view: 'workbench', id }));

  return (
    <>
      <SettingRow
        label="Memory review"
        description="Talyn starts a thread that merges notes that overlap and settles notes that disagree. Each review uses your agent subscription. Talyn skips a review when no note changed."
      >
        <div className="flex items-center gap-2">
          <select
            aria-label="Memory review"
            className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
            value={cadence}
            disabled={saving}
            onChange={(e) => void onChange(e.target.value as MemoryReviewCadence)}
          >
            {MEMORY_REVIEW_CADENCES.map((c) => (
              <option key={c} value={c}>
                {MEMORY_REVIEW_CADENCE_LABELS[c]}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" disabled={starting || memoryOff} onClick={() => void reviewNow()}>
            Review now
          </Button>
        </div>
      </SettingRow>
      {line ? <p className="px-3 pb-2 text-xs text-muted-foreground">{line}</p> : null}
    </>
  );
}

type Group = { key: string; label: string; mono: boolean; entries: MemoryEntrySummary[] };

function MemoryRow({
  entry,
  body,
  expanded,
  busy,
  justForgotten,
  onToggle,
  onEdit,
  onForget,
  onRestore,
}: {
  entry: MemoryEntrySummary;
  body: string | undefined;
  expanded: boolean;
  busy: boolean;
  justForgotten: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onForget: () => void;
  onRestore: () => void;
}) {
  const forgotten = Boolean(entry.forgottenAt);
  return (
    <div className="px-3 py-2 text-[13px]" data-testid="memory-row">
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} ${entry.name}`}
          onClick={onToggle}
          className={cn('min-w-0 flex-1 text-left', forgotten && 'opacity-60')}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('truncate font-medium', forgotten && 'line-through')}>{entry.name}</span>
            <MemoryTypeChip type={entry.type} />
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{entry.description}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {forgotten ? (
            <>
              {justForgotten ? <span className="text-xs text-muted-foreground">Forgotten</span> : null}
              <Button variant="outline" size="sm" disabled={busy} onClick={onRestore}>
                {justForgotten ? 'Undo' : 'Restore'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={busy} aria-label={`Edit ${entry.name}`} onClick={onEdit}>
                Edit
              </Button>
              <Button variant="outline" size="sm" disabled={busy} aria-label={`Forget ${entry.name}`} onClick={onForget}>
                Forget
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
        <MemorySourceLabel source={entry.source} />
        <span aria-hidden>·</span>
        <span title={new Date(entry.updatedAt).toLocaleString()}>Updated {ago(entry.updatedAt)}</span>
      </div>
      {expanded ? (
        <pre
          data-testid="memory-body"
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-xs [overflow-wrap:anywhere]"
        >
          {body ?? 'Loading…'}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * "Memory": the notes sessions save as they learn, and notes a person adds.
 * Grouped by where they apply: the workspace, then each repository.
 */
export function MemorySection() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const allRepositories = useWorkspaceStore((s) => s.repositories);
  const repositories = useMemo(
    () => allRepositories.filter((r) => r.workspaceId === workspaceId),
    [allRepositories, workspaceId],
  );
  const [entries, setEntries] = useState<MemoryEntrySummary[] | null>(null);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [showForgotten, setShowForgotten] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [justForgotten, setJustForgotten] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    setError(null);
    api.workbenches.memory
      .list({ workspaceId, ...(search ? { q: search } : {}), ...(showForgotten ? { includeForgotten: true } : {}) })
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        if (!search) setLiveCount(list.filter((e) => !e.forgottenAt).length);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load memory');
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, search, showForgotten]);

  const groups = useMemo<Group[]>(() => {
    const workspace: Group = { key: 'workspace', label: 'Workspace', mono: false, entries: [] };
    const byRepo = new Map<string, Group>();
    const threads: Group = { key: 'thread', label: 'Threads', mono: false, entries: [] };
    for (const entry of entries ?? []) {
      if (entry.scope === 'workspace') workspace.entries.push(entry);
      else if (entry.scope === 'thread') threads.entries.push(entry);
      else {
        const key = entry.repositoryId ?? '';
        if (!byRepo.has(key)) {
          byRepo.set(key, { key: `repo:${key}`, label: memoryScopeLabel(entry, repositories), mono: true, entries: [] });
        }
        byRepo.get(key)!.entries.push(entry);
      }
    }
    const repoGroups = [...byRepo.values()].sort((a, b) => a.label.localeCompare(b.label));
    return [workspace, ...repoGroups, threads].filter((g) => g.entries.length > 0);
  }, [entries, repositories]);

  if (!workspaceId) return null;

  const replace = (entry: MemoryEntrySummary) =>
    setEntries((list) => (list ?? []).map((e) => (e.id === entry.id ? entry : e)));

  const onSaved = (entry: MemoryEntry, outcome: 'created' | 'updated') => {
    const { body, ...summary } = entry;
    setBodies((b) => ({ ...b, [entry.id]: body }));
    setEntries((list) => {
      const current = list ?? [];
      return current.some((e) => e.id === entry.id) ? current.map((e) => (e.id === entry.id ? summary : e)) : [...current, summary];
    });
    if (outcome === 'created') setLiveCount((n) => (n === null ? n : n + 1));
  };

  const toggle = (id: string) => {
    const open = !expanded.has(id);
    setExpanded((set) => {
      const next = new Set(set);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
    if (open && bodies[id] === undefined) {
      api.workbenches.memory
        .get(id)
        .then((full) => setBodies((b) => ({ ...b, [id]: full.body })))
        .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load this memory'));
    }
  };

  const forget = async (entry: MemoryEntrySummary) => {
    setBusy(entry.id);
    try {
      replace(await api.workbenches.memory.forget(entry.id));
      setJustForgotten((set) => new Set(set).add(entry.id));
      setLiveCount((n) => (n === null ? n : n - 1));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not forget this memory');
    } finally {
      setBusy(null);
    }
  };

  const restore = async (entry: MemoryEntrySummary) => {
    setBusy(entry.id);
    try {
      const { body, ...summary } = await api.workbenches.memory.restore(entry.id);
      replace(summary);
      setBodies((b) => ({ ...b, [entry.id]: body }));
      setJustForgotten((set) => {
        const next = new Set(set);
        next.delete(entry.id);
        return next;
      });
      setLiveCount((n) => (n === null ? n : n + 1));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not restore this memory');
    } finally {
      setBusy(null);
    }
  };

  const full = liveCount !== null && liveCount >= MAX_LIVE_MEMORIES_PER_WORKSPACE;

  return (
    <SettingsSection
      title="Memory"
      description={INTRO}
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={entries === null || adding || full}
          title={full ? memoryLimitMessage() : undefined}
          onClick={() => setAdding(true)}
        >
          Add memory
        </Button>
      }
    >
      <SessionMemorySwitch workspaceId={workspaceId} />
      <MemoryReviewRow workspaceId={workspaceId} />
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <input
          type="search"
          aria-label="Search memory"
          placeholder="Search memory"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-xs"
        />
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={showForgotten} onChange={(e) => setShowForgotten(e.target.checked)} />
          Show forgotten
        </label>
        {liveCount !== null ? (
          <span data-testid="memory-count" className={cn('text-xs', full ? 'text-destructive' : 'text-muted-foreground')}>
            {liveCount} of {MAX_LIVE_MEMORIES_PER_WORKSPACE}
          </span>
        ) : null}
      </div>
      {adding ? (
        <MemoryEditor
          workspaceId={workspaceId}
          repositories={repositories}
          onClose={() => setAdding(false)}
          onSaved={onSaved}
        />
      ) : null}
      {error ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : entries === null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {search ? `No notes match "${search}".` : EMPTY}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.key} role="group" aria-label={group.label} className="divide-y divide-border/60">
            <div
              className={cn(
                'bg-muted/30 px-3 py-1 text-[11px] font-medium text-muted-foreground',
                group.mono && 'font-mono',
              )}
            >
              {group.label}
            </div>
            {group.entries.map((entry) =>
              editing === entry.id ? (
                <MemoryEditor
                  key={entry.id}
                  workspaceId={workspaceId}
                  entry={bodies[entry.id] !== undefined ? { ...entry, body: bodies[entry.id] } : entry}
                  repositories={repositories}
                  onClose={() => setEditing(null)}
                  onSaved={onSaved}
                />
              ) : (
                <MemoryRow
                  key={entry.id}
                  entry={entry}
                  body={bodies[entry.id]}
                  expanded={expanded.has(entry.id)}
                  busy={busy === entry.id}
                  justForgotten={justForgotten.has(entry.id)}
                  onToggle={() => toggle(entry.id)}
                  onEdit={() => setEditing(entry.id)}
                  onForget={() => void forget(entry)}
                  onRestore={() => void restore(entry)}
                />
              ),
            )}
          </div>
        ))
      )}
    </SettingsSection>
  );
}
