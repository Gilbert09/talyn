import { useEffect, useState, type ReactNode } from 'react';
import {
  MAX_MEMORY_BODY_BYTES,
  MAX_MEMORY_DESCRIPTION_CHARS,
  MAX_MEMORY_NAME_CHARS,
  MEMORY_TYPES,
  validateMemoryInput,
  validateMemoryUpdate,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryScope,
  type MemorySource,
  type MemoryType,
  type PutMemoryInput,
  type UpdateMemoryInput,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { useNavigationStore } from '../../stores/navigation';
import { Button } from '../ui/button';
import { SettingsSelect } from '../ui/settings';

export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  user: 'User',
  feedback: 'Feedback',
  project: 'Project',
  reference: 'Reference',
};

export function MemoryTypeChip({ type }: { type: MemoryType }) {
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {MEMORY_TYPE_LABEL[type]}
    </span>
  );
}

type RepoRef = { id: string; fullName: string };

/** "Workspace", the repository's name, or "Thread". */
export function memoryScopeLabel(
  entry: { scope: MemoryScope; repositoryId?: string | null },
  repositories: readonly RepoRef[],
): string {
  if (entry.scope === 'workspace') return 'Workspace';
  if (entry.scope === 'thread') return 'Thread';
  return repositories.find((r) => r.id === entry.repositoryId)?.fullName ?? 'Repository';
}

/** Who wrote the entry. A session links to that session. */
export function MemorySourceLabel({ source }: { source: MemorySource }) {
  if (source.kind === 'session' && source.workbenchId) {
    return (
      <button
        type="button"
        className="underline-offset-2 hover:text-foreground hover:underline"
        onClick={(e) => {
          e.stopPropagation();
          useNavigationStore.getState().navigate({ view: 'workbench', id: source.workbenchId });
        }}
      >
        Saved by a session
      </button>
    );
  }
  if (source.kind === 'session') return <span>Saved by a session</span>;
  if (source.kind === 'auto') return <span>Saved automatically</span>;
  return <span>Added by you</span>;
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

const inputClass =
  'h-7 w-full rounded-md border border-input bg-background px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

function Field({
  label,
  count,
  over,
  children,
}: {
  label: string;
  count: string;
  over: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className={cn(over && 'text-destructive')}>{count}</span>
      </div>
      {children}
    </div>
  );
}

const WORKSPACE_TARGET = 'workspace';

/**
 * Create or edit one memory entry. With `entry`, an edit (the scope does not
 * change). Without it, a create with a scope picker: the workspace or one of
 * `repositories`.
 */
export function MemoryEditor({
  workspaceId,
  entry,
  repositories,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  entry?: MemoryEntrySummary | MemoryEntry;
  repositories: readonly RepoRef[];
  onClose: () => void;
  onSaved: (entry: MemoryEntry, outcome: 'created' | 'updated') => void;
}) {
  const editing = Boolean(entry);
  const initialBody = entry && 'body' in entry ? entry.body : undefined;
  const [loaded, setLoaded] = useState(!entry || initialBody !== undefined);
  const [original, setOriginal] = useState<MemoryEntry | null>(
    entry && initialBody !== undefined ? (entry as MemoryEntry) : null,
  );
  const [target, setTarget] = useState(WORKSPACE_TARGET);
  const [name, setName] = useState(entry?.name ?? '');
  const [type, setType] = useState<MemoryType>(entry?.type ?? 'project');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [body, setBody] = useState(initialBody ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!entry || loaded) return undefined;
    let cancelled = false;
    api.workbenches.memory
      .get(entry.id)
      .then((full) => {
        if (cancelled) return;
        setOriginal(full);
        setName(full.name);
        setType(full.type);
        setDescription(full.description);
        setBody(full.body);
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : 'Could not load this memory');
        onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [entry?.id]);

  const nameLength = name.trim().length;
  const descriptionLength = description.trim().length;
  const bytes = byteLength(body);

  const save = async () => {
    setError(null);
    if (entry && original) {
      const patch: UpdateMemoryInput = {};
      if (name !== original.name) patch.name = name;
      if (type !== original.type) patch.type = type;
      if (description !== original.description) patch.description = description;
      if (body !== original.body) patch.body = body;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      const checked = validateMemoryUpdate(patch);
      if (!checked.ok) {
        setError(checked.error);
        return;
      }
      setSaving(true);
      try {
        const saved = await api.workbenches.memory.update(entry.id, patch);
        onSaved(saved, 'updated');
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save this memory');
      } finally {
        setSaving(false);
      }
      return;
    }
    const input: PutMemoryInput = {
      workspaceId,
      scope: target === WORKSPACE_TARGET ? 'workspace' : 'repository',
      ...(target === WORKSPACE_TARGET ? {} : { repositoryId: target }),
      type,
      name,
      description,
      body,
    };
    const checked = validateMemoryInput(input);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setSaving(true);
    try {
      const result = await api.workbenches.memory.put(input);
      if (result.outcome === 'updated') toast.info(`Updated the entry "${result.entry.name}", which had the same name`);
      onSaved(result.entry, result.outcome);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this memory');
    } finally {
      setSaving(false);
    }
  };

  const disabled = !loaded || saving;

  return (
    <div className="space-y-2 px-3 py-3" data-testid="memory-editor">
      <div className="flex flex-wrap items-end gap-2">
        {editing ? null : (
          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground">Applies to</div>
            <SettingsSelect
              aria-label="Memory scope"
              value={target}
              disabled={disabled}
              onChange={(e) => setTarget(e.target.value)}
              className="w-48"
            >
              <option value={WORKSPACE_TARGET}>Every session in this workspace</option>
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.fullName}
                </option>
              ))}
            </SettingsSelect>
          </div>
        )}
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">Type</div>
          <SettingsSelect
            aria-label="Memory type"
            value={type}
            disabled={disabled}
            onChange={(e) => setType(e.target.value as MemoryType)}
            className="w-28"
          >
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {MEMORY_TYPE_LABEL[t]}
              </option>
            ))}
          </SettingsSelect>
        </div>
      </div>
      <Field label="Name" count={`${nameLength} / ${MAX_MEMORY_NAME_CHARS}`} over={nameLength > MAX_MEMORY_NAME_CHARS}>
        <input
          aria-label="Memory name"
          value={name}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
          placeholder="For example: build command"
          className={inputClass}
        />
      </Field>
      <Field
        label="Description"
        count={`${descriptionLength} / ${MAX_MEMORY_DESCRIPTION_CHARS}`}
        over={descriptionLength > MAX_MEMORY_DESCRIPTION_CHARS}
      >
        <input
          aria-label="Memory description"
          value={description}
          disabled={disabled}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One sentence. Sessions see this in every turn."
          className={inputClass}
        />
      </Field>
      <Field label="Note" count={`${kb(bytes)} of ${kb(MAX_MEMORY_BODY_BYTES)}`} over={bytes > MAX_MEMORY_BODY_BYTES}>
        <textarea
          aria-label="Memory note"
          value={body}
          disabled={disabled}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
          rows={6}
          placeholder={loaded ? 'The full note. A session reads it when it needs it.' : 'Loading…'}
          className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
      </Field>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
