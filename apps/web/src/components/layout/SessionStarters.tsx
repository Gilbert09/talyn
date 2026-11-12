import { useMemo } from 'react';
import { BookOpen, CircleX, Eye, FlaskConical, GitMerge, MessageSquare, Sparkles, type LucideIcon } from 'lucide-react';
import { sessionStarters, type SessionStarter, type SessionStarterKind } from '@talyn/shared';
import { Button } from '../ui/button';
import { openNewWorkbench, prefillFromPr } from '../workbench/new/openNewWorkbench';
import { usePullRequestStore } from '../../stores/pullRequests';
import { trackEvent } from '../../lib/analytics';

const ICONS: Record<SessionStarterKind, LucideIcon> = {
  fix_checks: CircleX,
  resolve_conflicts: GitMerge,
  address_review: MessageSquare,
  review: Eye,
  explain: BookOpen,
  tests: FlaskConical,
};

/**
 * The sidebar for somebody with no sessions yet: what a session is, and a few
 * jobs to start one with. A job on one of their own pull requests comes first.
 */
export function SessionStarters() {
  const rows = usePullRequestStore((s) => s.rows);
  const starters = useMemo(() => sessionStarters(rows), [rows]);

  const start = (starter: SessionStarter) => {
    trackEvent('session_starter_clicked', { kind: starter.kind, from_pull_request: starter.pr !== null });
    const row = starter.pr ? rows.find((r) => r.id === starter.pr?.id) : undefined;
    openNewWorkbench({ ...(row ? prefillFromPr(row) : {}), prompt: starter.prompt });
  };

  return (
    <div className="mx-2 my-1 rounded-lg border border-border/70 bg-background/50 p-3" data-attr="session-starters">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
        Hand work to an agent
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        A session is an agent in a cloud sandbox with your repository. It fixes, reviews or builds code, and pushes the
        result to a branch.
      </p>
      <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Try one</p>
      <ul className="mt-1 space-y-0.5">
        {starters.map((starter) => {
          const Icon = ICONS[starter.kind];
          return (
            <li key={starter.key}>
              <button
                type="button"
                onClick={() => start(starter)}
                className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-xs text-foreground">{starter.label}</span>
                  {starter.detail && (
                    <span className="block truncate text-[11px] text-muted-foreground">{starter.detail}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => openNewWorkbench()}>
        Start a session
      </Button>
    </div>
  );
}
