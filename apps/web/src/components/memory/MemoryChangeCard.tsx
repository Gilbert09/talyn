import { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import type { MemoryChangeEvent, MemoryEntry } from '@talyn/shared';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { MemoryEditor, MemoryTypeChip, memoryScopeLabel } from './MemoryEditor';

const TITLE: Record<MemoryChangeEvent['action'], string> = {
  created: 'Saved to memory',
  updated: 'Updated memory',
  forgotten: 'Forgot a memory',
};

type State =
  | { status: 'loading' }
  | { status: 'found'; entry: MemoryEntry }
  | { status: 'gone' }
  | { status: 'error' };

/**
 * A `talyn_memory` transcript event: a session saved, changed or forgot a
 * memory entry. Reads the entry as it is now, so the card can edit, forget or
 * restore it. An entry that no longer exists keeps the name from the event.
 */
export function MemoryChangeCard({ change }: { change: MemoryChangeEvent }) {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.workbenches.memory
      .get(change.memoryId)
      .then((entry) => {
        if (!cancelled) setState(entry ? { status: 'found', entry } : { status: 'gone' });
      })
      .catch((e) => {
        if (cancelled) return;
        setState((e as { status?: number })?.status === 404 ? { status: 'gone' } : { status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [change.memoryId]);

  const entry = state.status === 'found' ? state.entry : null;
  const forgotten = Boolean(entry?.forgottenAt);
  const name = entry?.name ?? change.name;
  const type = entry?.type ?? change.memoryType;
  const scope = memoryScopeLabel(entry ?? { scope: change.scope }, repositories);
  const actionable = entry !== null && !busy;

  const forget = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      const summary = await api.workbenches.memory.forget(entry.id);
      setState({ status: 'found', entry: { ...entry, ...summary } });
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not forget this memory');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      setState({ status: 'found', entry: await api.workbenches.memory.restore(entry.id) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not restore this memory');
    } finally {
      setBusy(false);
    }
  };

  const note =
    state.status === 'gone'
      ? 'No longer in memory'
      : state.status === 'error'
        ? 'Could not load this memory'
        : forgotten
          ? 'Forgotten. Sessions no longer see it.'
          : null;

  return (
    <div className="rounded-md border border-border bg-card text-xs" data-testid="memory-change">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{TITLE[change.action]}</span>
        <span className="min-w-0 truncate font-medium" title={name}>
          {name}
        </span>
        <MemoryTypeChip type={type} />
        <span className="truncate text-muted-foreground">{scope}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {forgotten ? (
            <Button variant="outline" size="sm" disabled={!actionable} onClick={() => void restore()}>
              Restore
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={!actionable || editing} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="outline" size="sm" disabled={!actionable} onClick={() => void forget()}>
                Forget
              </Button>
            </>
          )}
        </div>
      </div>
      {note ? <p className="px-3 pb-2 text-muted-foreground">{note}</p> : null}
      {editing && entry ? (
        <div className="border-t border-border/60">
          <MemoryEditor
            workspaceId={entry.workspaceId}
            entry={entry}
            repositories={repositories}
            onClose={() => setEditing(false)}
            onSaved={(saved) => setState({ status: 'found', entry: saved })}
          />
        </div>
      ) : null}
    </div>
  );
}
