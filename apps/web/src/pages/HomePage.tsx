import { workbenchesOffered } from '@talyn/shared';
import { CheckCircle2, CircleDashed, FolderPlus, GitPullRequest, Loader2 } from 'lucide-react';
import { agentChoice, sandboxChoice, useReadiness, type Choice } from '../lib/readiness';
import { useWorkspaceStore } from '../stores/workspace';
import { useNavigationStore } from '../stores/navigation';
import { Button } from '../components/ui/button';
import { NewWorkbenchPage } from './NewWorkbenchPage';

export function HomePage() {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const features = useWorkspaceStore((s) => s.features);
  if (features === null) return null;
  if (!workbenchesOffered(features)) return <NotOffered />;
  if (repositories.length === 0) return <Welcome />;
  return <NewWorkbenchPage />;
}

export function Welcome() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setAddRepositoryOpen = useNavigationStore((s) => s.setAddRepositoryOpen);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const readiness = useReadiness(workspaceId);
  const loading = Boolean(workspaceId) && readiness.sandbox === null;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center" data-attr="home-welcome">
      <div className="space-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Welcome to Talyn</h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          Add a repository to start a session. Each session has an agent chat, changes and a terminal.
        </p>
      </div>
      <Button className="gap-1.5" onClick={() => setAddRepositoryOpen(true)}>
        <FolderPlus className="h-4 w-4" /> Add repository
      </Button>
      <ul
        className="w-full max-w-sm space-y-1.5 rounded-lg border border-border bg-card p-3 text-left text-xs"
        aria-label="Agents"
      >
        <StatusLine label="Sandbox" choice={sandboxChoice(readiness)} loading={loading} />
        <StatusLine label="Claude Code" choice={agentChoice(readiness, 'claude')} loading={loading} />
        <StatusLine label="Codex" choice={agentChoice(readiness, 'codex')} loading={loading} />
      </ul>
      <p className="max-w-md text-xs text-muted-foreground">
        Connect your Claude or ChatGPT subscription in{' '}
        <button type="button" className="underline hover:text-foreground" onClick={() => openSettings('integrations')}>
          Settings → Integrations
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
          <span className="block text-muted-foreground">
            {choice.available ? (choice.warning ?? 'Ready') : choice.reason}
          </span>
        )}
      </span>
    </li>
  );
}

function NotOffered() {
  const navigate = useNavigationStore((s) => s.navigate);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="max-w-md text-sm text-muted-foreground">Sessions are not available on this account.</p>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate({ view: 'prs', tab: 'my_prs' })}>
        <GitPullRequest className="h-4 w-4" /> Open pull requests
      </Button>
    </div>
  );
}
