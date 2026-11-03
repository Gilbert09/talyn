import { useEffect, useState } from 'react';
import {
  userSetupStepCheck,
  type PutWorkspaceSandboxSetupInput,
  type SandboxDotfiles,
  type SetupListStep,
  type WorkspaceSandboxSetup,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Button } from '../../ui/button';
import { SettingsPage } from '../../ui/settings';
import { SetupHostsEditor, SetupStepList, errorText } from '../../widgets/SetupList';

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const rebuildNote = 'A change here rebuilds your images for each repository the next time you start a session there. The first session after a change starts from the shared repository image and runs these steps itself.';
const privateNote = 'Private repositories are cloned with your GitHub connection, read-only. The token is never stored in an image.';

/** Check the dotfiles form as the backend does. Null: it is good. */
export function dotfilesProblem(slug: string, install: string): string | null {
  if (!SLUG.test(slug.trim())) return 'The repository must be owner/name.';
  if (install.trim()) {
    const check = userSetupStepCheck(install);
    if (check.refusal) return check.refusal;
    if (check.forceBox) return 'The install command reads a secret. The image build has no secrets.';
  }
  return null;
}

function DotfilesForm({ workspaceId, dotfiles, busy, onSave }: {
  workspaceId: string;
  dotfiles: SandboxDotfiles | null;
  busy: boolean;
  onSave: (dotfiles: SandboxDotfiles | null) => Promise<boolean>;
}) {
  const [slug, setSlug] = useState(dotfiles?.slug ?? '');
  const [ref, setRef] = useState(dotfiles?.ref ?? '');
  const [install, setInstall] = useState(dotfiles?.install ?? '');
  const [repos, setRepos] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    setSlug(dotfiles?.slug ?? '');
    setRef(dotfiles?.ref ?? '');
    setInstall(dotfiles?.install ?? '');
  }, [dotfiles?.slug, dotfiles?.ref, dotfiles?.install]);

  useEffect(() => {
    let active = true;
    void api.github.listRepos(workspaceId)
      .then((list) => { if (active) setRepos(list.map((repo) => repo.full_name)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [workspaceId]);

  const save = async () => {
    const problem = dotfilesProblem(slug, install);
    if (problem) { setError(problem); return; }
    setError('');
    await onSave({ slug: slug.trim(), ref: ref.trim(), install: install.trim() ? install.trim() : null });
  };

  return (
    <div className="space-y-2 text-xs" data-attr="sandbox-dotfiles">
      <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Dotfiles</h2>
      <p className="max-w-prose text-muted-foreground">Each image clones this repository and runs its install command, before the steps below.</p>
      <label className="block space-y-1">
        <span>Repository</span>
        <input
          aria-label="Dotfiles repository"
          list={`dotfiles-repos-${workspaceId}`}
          value={slug}
          onChange={(event) => { setSlug(event.target.value); setError(''); }}
          placeholder="owner/dotfiles"
          className="w-full rounded border bg-background px-2 py-1 font-mono"
        />
        <datalist id={`dotfiles-repos-${workspaceId}`}>
          {repos.map((name) => <option key={name} value={name} />)}
        </datalist>
      </label>
      <label className="block space-y-1">
        <span>Branch, tag or commit</span>
        <input
          aria-label="Dotfiles branch"
          value={ref}
          onChange={(event) => { setRef(event.target.value); setError(''); }}
          placeholder="Default branch"
          className="w-full rounded border bg-background px-2 py-1 font-mono"
        />
      </label>
      <label className="block space-y-1">
        <span>Install command</span>
        <input
          aria-label="Dotfiles install command"
          value={install}
          onChange={(event) => { setInstall(event.target.value); setError(''); }}
          placeholder="Find it: install.sh, setup.sh, bootstrap, make install"
          className="w-full rounded border bg-background px-2 py-1 font-mono"
        />
      </label>
      <p className="max-w-prose text-muted-foreground">{privateNote}</p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>Save dotfiles</Button>
        {dotfiles && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onSave(null)}>Remove dotfiles</Button>}
      </div>
    </div>
  );
}

/** Settings → Sandbox setup: the dotfiles and the steps that every repository's image gets. */
export function SandboxSetupSettings() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [setup, setSetup] = useState<WorkspaceSandboxSetup | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let active = true;
    setSetup(null);
    setLoadError('');
    void api.workspaces.sandboxSetup.get(workspaceId)
      .then((next) => { if (active) setSetup(next); })
      .catch((err) => { if (active) setLoadError(errorText(err, 'Could not load the sandbox setup.')); });
    return () => { active = false; };
  }, [workspaceId]);

  const put = async (input: PutWorkspaceSandboxSetupInput): Promise<boolean> => {
    if (!workspaceId) return false;
    setBusy(true);
    setError('');
    try {
      setSetup(await api.workspaces.sandboxSetup.put(workspaceId, input));
      return true;
    } catch (err) {
      setError(errorText(err, 'Could not save the sandbox setup.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const retry = async (step: SetupListStep) => {
    if (!workspaceId) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.workspaces.sandboxSetup.retryStep(workspaceId, step.id);
      setSetup((current) => current && { ...current, steps: current.steps.map((other) => (other.id === next.id ? next : other)) });
    } catch (err) {
      setError(errorText(err, 'Could not retry the step.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage title="Sandbox setup" description="This setup applies to every repository of the workspace.">
      {!workspaceId ? (
        <p className="text-xs text-muted-foreground">Choose a workspace first.</p>
      ) : loadError ? (
        <p role="alert" className="text-xs text-destructive">{loadError}</p>
      ) : !setup ? (
        <p className="text-xs text-muted-foreground">Loading the sandbox setup…</p>
      ) : (
        <div className="space-y-6 text-xs" data-attr="sandbox-setup">
          <DotfilesForm workspaceId={workspaceId} dotfiles={setup.dotfiles} busy={busy} onSave={(dotfiles) => put({ dotfiles })} />
          <div className="space-y-2">
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Steps</h2>
            <p className="max-w-prose text-muted-foreground">These steps run for every repository, in this order. They come after the dotfiles and before the steps of the repository.</p>
            <SetupStepList
              steps={setup.steps}
              busy={busy}
              maxSec={setup.limits.stepMaxSec}
              maxUserSteps={setup.limits.maxUserSteps}
              emptyText="No steps yet."
              onPut={(steps) => put({ steps })}
              actions={{ onRetry: (step) => void retry(step) }}
            />
          </div>
          <SetupHostsEditor
            inputId={`sandbox-host-${workspaceId}`}
            hosts={setup.hosts}
            max={setup.limits.maxHosts}
            busy={busy}
            onSave={(hosts) => put({ hosts })}
          />
          {error && <p role="alert" className="max-w-prose text-destructive" data-attr="sandbox-setup-error">{error}</p>}
          <p className="max-w-prose text-muted-foreground" data-attr="sandbox-setup-rebuild-note">{rebuildNote}</p>
        </div>
      )}
    </SettingsPage>
  );
}
