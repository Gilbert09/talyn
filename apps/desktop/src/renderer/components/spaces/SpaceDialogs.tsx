import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { MAX_SPACE_NAME_LENGTH, MAX_TEAM_NAME_LENGTH, type SpaceRepository } from '@talyn/shared';
import { api } from '../../lib/api';
import { switchContext } from '../../lib/spaces';
import { useSpacesStore } from '../../stores/spaces';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { RepoPicker } from '../workbench/new/NewWorkbenchControls';

export const SPACE_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  maxLength,
  submitLabel,
  onSubmit,
  children,
  renderField,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  submitLabel: string;
  onSubmit: (value: string) => Promise<void>;
  children?: React.ReactNode;
  /** Replaces the text input, for a field like the repository picker. */
  renderField?: (value: string, setValue: (value: string) => void) => React.ReactNode;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err, 'Something went wrong.'));
    } finally {
      setBusy(false);
    }
  };

  const close = (next: boolean) => {
    if (!busy) onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent onClose={() => close(false)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-3 py-2">
          {renderField ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">{label}</p>
              {renderField(value, setValue)}
            </div>
          ) : (
            <label className="block text-sm font-medium">
              {label}
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
                maxLength={maxLength}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
                className="mt-1"
              />
            </label>
          )}
          {children}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !value.trim()}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateTeamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create a team"
      description="A team shares spaces. Teammates see each other's sessions in a space, and each runs on their own account."
      label="Team name"
      placeholder="e.g. PostHog"
      maxLength={MAX_TEAM_NAME_LENGTH}
      submitLabel="Create team"
      onSubmit={async (name) => {
        const team = await api.teams.create({ name });
        useSpacesStore.getState().upsertTeam(team);
      }}
    />
  );
}

export function CreateSpaceDialog({
  teamId,
  onOpenChange,
}: {
  teamId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [color, setColor] = useState(SPACE_COLORS[0]);
  return (
    <NameDialog
      open={teamId !== null}
      onOpenChange={onOpenChange}
      title="New space"
      description="Everyone in the team can see the space."
      label="Space name"
      placeholder="e.g. Web app"
      maxLength={MAX_SPACE_NAME_LENGTH}
      submitLabel="Create space"
      onSubmit={async (name) => {
        if (!teamId) return;
        const space = await api.teams.createSpace(teamId, { name, color });
        useSpacesStore.getState().upsertSpace(space);
        switchContext({ kind: 'space', spaceId: space.id });
      }}
    >
      <ColorPicker value={color} onChange={setColor} />
    </NameDialog>
  );
}

export function ColorPicker({ value, onChange }: { value: string | null; onChange: (color: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Colour">
      {SPACE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={`h-5 w-5 rounded-full ring-offset-background ${value === c ? 'ring-2 ring-ring ring-offset-2' : ''}`}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

export function AddSpaceRepositoryDialog({
  spaceId,
  onOpenChange,
  onAdded,
}: {
  spaceId: string | null;
  onOpenChange: (open: boolean) => void;
  onAdded?: (repo: SpaceRepository) => void;
}) {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const existing = useSpacesStore((s) => (spaceId ? s.repositories[spaceId] : undefined));
  const taken = new Set((existing ?? []).map((r) => r.repoFullName.toLowerCase()));
  // Keyed by full name, so the picker hands back `owner/name` for a listed or a typed repository.
  const choices = repositories
    .filter((r) => !taken.has(r.fullName.toLowerCase()))
    .map((r) => ({ ...r, id: r.fullName }));
  return (
    <NameDialog
      open={spaceId !== null}
      onOpenChange={onOpenChange}
      title="Add a repository to the space"
      description="Your GitHub account must be able to read it."
      label="Repository"
      submitLabel="Add repository"
      renderField={(value, setValue) => (
        <RepoPicker
          repositories={choices}
          value={value}
          onChange={setValue}
          allowCustom
          composerShortcut={false}
          emptyText="No watched repository matches. Type owner/name to add any repository."
          className="h-9 w-full max-w-none border border-input px-3 text-sm"
        />
      )}
      onSubmit={async (name) => {
        if (!spaceId) return;
        const repo = await api.spaces.addRepository(spaceId, name);
        const store = useSpacesStore.getState();
        const current = store.repositories[spaceId] ?? [];
        store.setRepositories(spaceId, [...current.filter((r) => r.repoFullName !== repo.repoFullName), repo]);
        onAdded?.(repo);
      }}
    />
  );
}

export function SpaceDialogsHost() {
  const dialog = useSpacesStore((s) => s.dialog);
  const openDialog = useSpacesStore((s) => s.openDialog);
  const close = (open: boolean) => {
    if (!open) openDialog(null);
  };
  return (
    <>
      <CreateTeamDialog open={dialog?.kind === 'createTeam'} onOpenChange={close} />
      <CreateSpaceDialog teamId={dialog?.kind === 'createSpace' ? dialog.teamId : null} onOpenChange={close} />
      <AddSpaceRepositoryDialog spaceId={dialog?.kind === 'addRepository' ? dialog.spaceId : null} onOpenChange={close} />
    </>
  );
}
