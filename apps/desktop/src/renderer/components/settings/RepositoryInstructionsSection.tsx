import { useEffect, useMemo, useState } from 'react';
import {
  MAX_REPOSITORY_INSTRUCTION_BYTES,
  type RepositoryInstructionAgents,
  type RepositoryInstructionsSummary,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { SettingRow, SettingsSection } from '../ui/settings';

const INTRO = 'Added to every session on this repository, for the agents you choose. Not committed.';

const AGENT_OPTIONS: Array<{ value: RepositoryInstructionAgents; label: string }> = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'both', label: 'Both' },
];

const AGENT_LABEL: Record<RepositoryInstructionAgents, string> = { claude: 'Claude', codex: 'Codex', both: 'Claude and Codex' };

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function AgentSwitch({
  value,
  onChange,
  disabled,
}: {
  value: RepositoryInstructionAgents;
  onChange: (value: RepositoryInstructionAgents) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Agents" className="inline-flex rounded-md border border-input p-0.5">
      {AGENT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded px-2.5 py-1 text-xs transition-colors',
            value === option.value ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Editor({
  repositoryId,
  fullName,
  existing,
  onClose,
  onSaved,
  onDeleted,
}: {
  repositoryId: string;
  fullName: string;
  existing: boolean;
  onClose: () => void;
  onSaved: (summary: RepositoryInstructionsSummary) => void;
  onDeleted: () => void;
}) {
  const [loaded, setLoaded] = useState(!existing);
  const [body, setBody] = useState('');
  const [agents, setAgents] = useState<RepositoryInstructionAgents>('both');
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!existing) return undefined;
    let cancelled = false;
    api.repositories.instructions
      .get(repositoryId)
      .then((found) => {
        if (cancelled) return;
        if (found) {
          setBody(found.body);
          setAgents(found.agents);
        }
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : 'Could not load these instructions');
        onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryId, existing]);

  const bytes = byteLength(body);
  const tooLarge = bytes > MAX_REPOSITORY_INSTRUCTION_BYTES;
  const empty = body.trim() === '';

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.repositories.instructions.put(repositoryId, { body, agents });
      onSaved({ repositoryId, agents: saved.agents, bytes: saved.bytes, updatedAt: saved.updatedAt });
      toast.success(`Instructions saved for ${fullName}`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save these instructions');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await api.repositories.instructions.remove(repositoryId);
      onDeleted();
      toast.success(`Instructions deleted for ${fullName}`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete these instructions');
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 px-3 py-3" data-testid="repository-instructions-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs">{fullName}</span>
        <AgentSwitch value={agents} onChange={setAgents} disabled={saving} />
      </div>
      <textarea
        aria-label={`Instructions for ${fullName}`}
        value={body}
        disabled={!loaded || saving}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
        rows={10}
        placeholder={loaded ? 'Write markdown, for example how to run the tests or which style to follow.' : 'Loading…'}
        className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          data-testid="repository-instructions-count"
          className={cn('text-xs', tooLarge ? 'text-destructive' : 'text-muted-foreground')}
        >
          {kb(bytes)} of {kb(MAX_REPOSITORY_INSTRUCTION_BYTES)}
        </span>
        <div className="flex items-center gap-2">
          {existing ? (
            confirmingDelete ? (
              <>
                <span className="text-xs text-muted-foreground">Delete these instructions?</span>
                <Button variant="destructive" size="sm" disabled={saving} onClick={() => void remove()}>
                  Confirm delete
                </Button>
                <Button variant="outline" size="sm" disabled={saving} onClick={() => setConfirmingDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" disabled={saving} onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            )
          ) : null}
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!loaded || saving || tooLarge || empty} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * "Repository instructions": text a person writes in Talyn for one
 * repository, delivered to every session on it (`CLAUDE.local.md` for Claude,
 * `AGENTS.override.md` for Codex) without a file on their machine.
 */
export function RepositoryInstructionsSection() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const repositories = useWorkspaceStore((s) => s.repositories);
  const [summaries, setSummaries] = useState<RepositoryInstructionsSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    setError(null);
    api.repositories.instructions
      .list(workspaceId)
      .then((list) => {
        if (!cancelled) setSummaries(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load repository instructions');
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const byRepo = useMemo(() => new Map((summaries ?? []).map((s) => [s.repositoryId, s])), [summaries]);
  const rows = repositories.filter((r) => r.workspaceId === workspaceId || !workspaceId);

  return (
    <SettingsSection title="Repository instructions" description={INTRO}>
      {error ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Add a repository first, then write instructions for it here.</p>
      ) : (
        rows.map((repo) => {
          const summary = byRepo.get(repo.id);
          if (editing === repo.id) {
            return (
              <Editor
                key={repo.id}
                repositoryId={repo.id}
                fullName={repo.fullName}
                existing={Boolean(summary)}
                onClose={() => setEditing(null)}
                onSaved={(saved) => setSummaries((list) => [...(list ?? []).filter((s) => s.repositoryId !== repo.id), saved])}
                onDeleted={() => setSummaries((list) => (list ?? []).filter((s) => s.repositoryId !== repo.id))}
              />
            );
          }
          return (
            <SettingRow
              key={repo.id}
              label={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-[11px]">{repo.fullName}</span>
                  {summary ? (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">Set</span>
                  ) : null}
                </span>
              }
              description={summary ? `${kb(summary.bytes)} · ${AGENT_LABEL[summary.agents]}` : undefined}
            >
              <Button
                variant="outline"
                size="sm"
                disabled={summaries === null}
                aria-label={`Edit instructions for ${repo.fullName}`}
                onClick={() => setEditing(repo.id)}
              >
                Edit
              </Button>
            </SettingRow>
          );
        })
      )}
    </SettingsSection>
  );
}
