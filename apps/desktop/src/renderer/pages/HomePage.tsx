import { useMemo } from 'react';
import { workbenchesOffered } from '@talyn/shared';
import { FolderPlus, GitPullRequest, Plus, Settings, SquareTerminal } from 'lucide-react';
import { formatKeys } from '../lib/shortcuts';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { Button } from '../components/ui/button';
import { Kbd } from '../components/ui/kbd';
import { isArchived, useWorkspaceWorkbenches } from '../components/workbench/workbenchSelectors';

/**
 * Home: where a new piece of work starts. A thin placeholder for now: the
 * new-workbench form opens as the existing dialog, and the page lists recent
 * workbenches. The full page (one big composer, repo and branch pickers)
 * replaces this.
 */
export function HomePage() {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const features = useWorkspaceStore((s) => s.features);

  if (repositories.length === 0) return <Welcome />;
  if (features !== null && !workbenchesOffered(features)) return <NotOffered />;
  return <StartWork />;
}

/** First run: no watched repositories yet. */
export function Welcome() {
  const setAddRepositoryOpen = useNavigationStore((s) => s.setAddRepositoryOpen);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center" data-attr="home-welcome">
      <h1 className="text-xl font-semibold">Welcome to Talyn</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Add the repositories you code in. Each workbench is one branch of one of them, with an agent chat, a live diff
        and a terminal.
      </p>
      <Button className="gap-1.5" onClick={() => setAddRepositoryOpen(true)}>
        <FolderPlus className="h-4 w-4" /> Add repository
      </Button>
      <p className="max-w-md text-xs text-muted-foreground">
        To run agents, connect your Claude or ChatGPT subscription in{' '}
        <button type="button" className="underline hover:text-foreground" onClick={() => openSettings('integrations')}>
          Settings → Integrations
        </button>
        .
      </p>
    </div>
  );
}

function NotOffered() {
  const navigate = useNavigationStore((s) => s.navigate);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <SquareTerminal className="h-8 w-8 text-muted-foreground" />
      <p className="max-w-md text-sm text-muted-foreground">Workbenches are not available on this account yet.</p>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate({ view: 'prs', tab: 'my_prs' })}>
        <GitPullRequest className="h-4 w-4" /> Open pull requests
      </Button>
    </div>
  );
}

function StartWork() {
  const all = useWorkspaceWorkbenches();
  const openNewDialog = useWorkbenchStore((s) => s.openNewDialog);
  const navigate = useNavigationStore((s) => s.navigate);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const recent = useMemo(
    () =>
      all
        .filter((w) => !isArchived(w))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5),
    [all]
  );

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6" data-attr="home-start">
      <div className="space-y-2 text-center">
        <h1 className="text-xl font-semibold">What do you want to build?</h1>
        <p className="text-sm text-muted-foreground">Start a workbench: a new branch with its own agent, diff and terminal.</p>
      </div>
      <Button className="gap-1.5" onClick={() => openNewDialog()}>
        <Plus className="h-4 w-4" /> New workbench
        <Kbd keys={formatKeys('mod+n')} className="ml-1 opacity-80" />
      </Button>
      {recent.length > 0 && (
        <div className="w-full max-w-md">
          <h2 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">Recent</h2>
          <ul>
            {recent.map((wb) => (
              <li key={wb.id}>
                <button
                  type="button"
                  onClick={() => navigate({ view: 'workbench', id: wb.id })}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate">{wb.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{wb.repoFullName}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        onClick={() => openSettings('integrations')}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Settings className="h-3 w-3" /> Agents and integrations
      </button>
    </div>
  );
}
