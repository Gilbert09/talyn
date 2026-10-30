import { useEffect, useState } from 'react';
import { ChevronDown, Github } from 'lucide-react';
import { SANDBOX_SIZES, type RepositoryBake, type RepositoryPreviewResponse, type RepositorySandboxSizeResponse } from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useWorkspaceStore, type WatchedRepo } from '../../stores/workspace';
import { Button } from '../ui/button';
import { PollingOnlyBadge } from '../widgets/PollingOnlyBadge';
import { RepoSandboxSize } from '../widgets/RepoSandboxSize';
import { RepoBake } from '../widgets/RepoBake';
import { RepositoryPreviewSettings } from './RepositoryPreviewSettings';

export function WebRepoRow({ repo, open, onToggle, disabled, hasInstructions, onInstructions, onRemove }: {
  repo: WatchedRepo;
  open: boolean;
  onToggle: () => void;
  disabled: boolean;
  hasInstructions: boolean;
  onInstructions: () => void;
  onRemove: () => void;
}) {
  const [size, setSize] = useState<RepositorySandboxSizeResponse | null>(null);
  const [bake, setBake] = useState<RepositoryBake | null>(null);
  const [preview, setPreview] = useState<RepositoryPreviewResponse | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const previewsEnabled = useWorkspaceStore((s) => s.features?.workbenches === true);
  useEffect(() => {
    let active = true;
    void api.repositories.sandboxSize.get(repo.id).then((next) => { if (active) setSize(next); }).catch(() => undefined);
    void api.repositories.bake.get(repo.id).then((next) => { if (active) setBake(next); }).catch(() => undefined);
    if (previewsEnabled) void api.repositories.preview.get(repo.id).then((next) => { if (active) setPreview(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [repo.id, previewsEnabled]);

  return <div className="border-b last:border-b-0">
    <button type="button" data-attr="settings-repo-row" aria-expanded={open} aria-controls={`repo-detail-${repo.id}`} onClick={onToggle} className="flex w-full items-center gap-2 p-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Github className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{repo.fullName}</span>
      <PollingOnlyBadge owner={repo.owner} />
      <span className="flex shrink-0 flex-wrap justify-end gap-1">
        {size && <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground" data-attr="settings-repo-size-pill">{SANDBOX_SIZES[size.effective].label}{size.setting === 'auto' ? ' (auto)' : ''}</span>}
        {!!bake?.steps.length && <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground" data-attr="settings-repo-bake-pill">Bake steps</span>}
        {previewsEnabled && preview?.target && preview.target !== 'off' && <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground" data-attr="settings-repo-preview-pill">Preview: {preview.user?.target ?? 'auto'}</span>}
        {hasInstructions && <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground" data-attr="settings-repo-instructions-pill">Instructions</span>}
      </span>
      <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
    </button>
    {open && <div id={`repo-detail-${repo.id}`} data-attr="settings-repo-detail" className="space-y-3 border-t bg-secondary/30 p-3">
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3"><span className="pt-1 text-xs text-muted-foreground">Sessions</span><RepoSandboxSize repositoryId={repo.id} hideLabel onInfoChange={setSize} /></div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3"><span className="pt-1 text-xs text-muted-foreground">Bake steps</span><RepoBake repositoryId={repo.id} onChange={setBake} /></div>
      {previewsEnabled && <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3"><span className="pt-1 text-xs text-muted-foreground">Preview</span><RepositoryPreviewSettings repositoryId={repo.id} repoName={repo.fullName} onConfigChange={setPreview} /></div>}
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3"><span className="text-xs text-muted-foreground">Instructions</span><button type="button" data-attr="settings-repo-edit-instructions" className="w-fit text-xs text-primary hover:underline" onClick={onInstructions}>Edit instructions</button></div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 border-t pt-3"><span />{confirmRemove ? <div className="flex items-center gap-2 text-xs"><span>Remove {repo.fullName}?</span><Button data-attr="settings-repo-confirm-remove" variant="destructive" size="sm" disabled={disabled} onClick={onRemove}>Remove</Button><Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>Cancel</Button></div> : <Button data-attr="settings-repo-remove" variant="ghost" size="sm" className="w-fit text-destructive hover:text-destructive" disabled={disabled} onClick={() => setConfirmRemove(true)}>Remove repository</Button>}</div>
    </div>}
  </div>;
}
