import { useState } from 'react';
import { workbenchesOffered } from '@talyn/shared';
import { CheckCircle2, CircleDashed, FolderOpen, FolderPlus, GitPullRequest, Loader2, SquareTerminal } from 'lucide-react';
import { api } from '../lib/api';
import { agentChoice, runtimeChoice, useReadiness, type Choice } from '../lib/readiness';
import { useWorkspaceActions } from '../hooks/useApi';
import { useWorkspaceStore } from '../stores/workspace';
import { useNavigationStore } from '../stores/navigation';
import { Button } from '../components/ui/button';
import { openNewWorkbench } from '../components/workbench/new/openNewWorkbench';
import { useRepoPaths } from '../components/workbench/new/useRepoPaths';
import { NewWorkbenchPage } from './NewWorkbenchPage';

/**
 * Home: where a new piece of work starts. With watched repositories it is the
 * new-workbench composer; without, a welcome that adds the first one.
 */
export function HomePage() {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const features = useWorkspaceStore((s) => s.features);

  if (repositories.length === 0) return <Welcome />;
  if (features !== null && !workbenchesOffered(features)) return <NotOffered />;
  return <NewWorkbenchPage />;
}

/** First run: no watched repositories yet. */
export function Welcome() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setAddRepositoryOpen = useNavigationStore((s) => s.setAddRepositoryOpen);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const { refreshWorkspaces } = useWorkspaceActions();
  const repoPaths = useRepoPaths();
  const readiness = useReadiness(workspaceId);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A local folder: the main process reads its GitHub remote and records the
  // path; Talyn then watches that repository and opens the composer on it.
  const openProject = async () => {
    if (!workspaceId) return;
    setError(null);
    setOpening(true);
    try {
      const picked = await repoPaths.pickFolder();
      if (!picked) return;
      const fullName = picked.repoFullName;
      if (!fullName) {
        setError('That folder has no GitHub remote Talyn can read. Add the repository by name instead.');
        return;
      }
      const [owner, name] = fullName.split('/');
      const { repositories, setRepositories } = useWorkspaceStore.getState();
      let watched = repositories.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
      if (!watched) {
        watched = await api.repositories.add(workspaceId, owner, name);
        setRepositories([...repositories, watched]);
        void refreshWorkspaces();
      }
      openNewWorkbench({ repositoryId: watched.id, runtime: 'local' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that folder.');
    } finally {
      setOpening(false);
    }
  };

  const state = { sandbox: readiness.sandbox, local: readiness.local };
  const runtimes = runtimeChoice(state);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center" data-attr="home-welcome">
      <div className="space-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Welcome to Talyn</h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          Add the repositories you code in. Each session is one branch of one of them, with an agent chat, a live diff
          and a terminal.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button className="gap-1.5" onClick={() => setAddRepositoryOpen(true)}>
          <FolderPlus className="h-4 w-4" /> Add repository
        </Button>
        {repoPaths.available && (
          <Button variant="outline" className="gap-1.5" onClick={() => void openProject()} disabled={opening}>
            {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />} Open project
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-md text-xs text-destructive">
          {error}
        </p>
      )}
      <ul className="w-full max-w-sm space-y-1.5 rounded-lg border border-border bg-card p-3 text-left text-xs" aria-label="Agents">
        <StatusLine label="Sandbox" choice={runtimes.sandbox} loading={Boolean(workspaceId) && readiness.sandbox === null} />
        {repoPaths.available && (
          <>
            <StatusLine
              label="Claude Code on this computer"
              choice={agentChoice(state, 'local', 'claude')}
              loading={readiness.local === null && readiness.loading}
            />
            <StatusLine
              label="Codex on this computer"
              choice={agentChoice(state, 'local', 'codex')}
              loading={readiness.local === null && readiness.loading}
            />
          </>
        )}
      </ul>
      <p className="max-w-md text-xs text-muted-foreground">
        To run agents in a sandbox, connect your Claude or ChatGPT subscription in{' '}
        <button type="button" className="underline hover:text-foreground" onClick={() => openSettings('agents')}>
          Settings → Agents
        </button>
        .
      </p>
    </div>
  );
}

function StatusLine({ label, choice, loading }: { label: string; choice: Choice; loading: boolean }) {
  return (
    <li className="flex items-start gap-2">
      {loading ? (
        <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : choice.available ? (
        <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <CircleDashed className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        {!loading && (
          <span className="block text-muted-foreground">{choice.available ? (choice.warning ?? 'Ready') : choice.reason}</span>
        )}
      </span>
    </li>
  );
}

function NotOffered() {
  const navigate = useNavigationStore((s) => s.navigate);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <SquareTerminal className="h-8 w-8 text-muted-foreground" />
      <p className="max-w-md text-sm text-muted-foreground">Sessions are not available on this account yet.</p>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate({ view: 'prs', tab: 'my_prs' })}>
        <GitPullRequest className="h-4 w-4" /> Open pull requests
      </Button>
    </div>
  );
}
