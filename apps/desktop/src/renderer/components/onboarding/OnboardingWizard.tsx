import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { useWorkspaceStore } from '../../stores/workspace';
import { useGithubConnection } from '../../hooks/useGithubConnection';
import { trackEvent } from '../../lib/analytics';
import { WorkspaceNameStep } from './steps/WorkspaceNameStep';
import { ConnectGitHubStep } from './steps/ConnectGitHubStep';
import { WatchReposStep } from './steps/WatchReposStep';
import { ConnectPostHogStep } from './steps/ConnectPostHogStep';

const STEPS = [
  { title: 'Name your workspace', optional: false },
  { title: 'Connect GitHub', optional: false },
  { title: 'Watch repositories', optional: true },
  { title: 'Connect a cloud agent', optional: true },
] as const;

/**
 * First-run onboarding. Walks a new user through the minimum setup a
 * cloud-only PR-management app needs: a named workspace, a GitHub
 * connection, repos to watch, and (optionally) a cloud agent. Shown by
 * App in place of MainLayout until `onboardingComplete` flips true.
 */
export function OnboardingWizard() {
  const { currentWorkspaceId, repositories, setOnboardingComplete } = useWorkspaceStore();
  const { status, user } = useGithubConnection(currentWorkspaceId);
  const [step, setStep] = useState(0);

  const githubConnected = Boolean(status?.connected);

  // Required steps gate the Next button; optional steps are always advanceable.
  const canAdvance =
    step === 0 ? !!currentWorkspaceId : step === 1 ? githubConnected : true;

  const isLast = step === STEPS.length - 1;
  // On the optional repos step, "Skip" only reads right when nothing's been
  // added yet; once a repo is watched it's a normal "Next".
  const nextLabel = STEPS[step].optional && step === 2 && repositories.length === 0 ? 'Skip' : 'Next';

  function handlePrimary() {
    if (isLast) {
      trackEvent('onboarding_completed', {
        github_connected: githubConnected,
        repos_watched: repositories.length,
      });
      setOnboardingComplete(true);
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to FastOwl</h1>
          <p className="text-sm text-muted-foreground">Let's get your workspace set up.</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2">
          {STEPS.map((s, i) => {
            const done = i < step;
            const active = i === step;
            return (
              <React.Fragment key={s.title}>
                <div
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full border text-xs font-medium',
                    done && 'border-green-600 bg-green-600 text-white',
                    active && !done && 'border-primary text-primary',
                    !done && !active && 'border-border text-muted-foreground'
                  )}
                  title={s.title}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={cn('h-px w-6', i < step ? 'bg-green-600' : 'bg-border')} />
                )}
              </React.Fragment>
            );
          })}
        </div>

        <div>
          <h2 className="mb-3 text-lg font-medium">
            {STEPS[step].title}
            {STEPS[step].optional && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>
            )}
          </h2>

          {step === 0 && <WorkspaceNameStep />}
          {step === 1 && (
            <ConnectGitHubStep workspaceId={currentWorkspaceId} status={status} user={user} />
          )}
          {step === 2 && currentWorkspaceId && (
            <WatchReposStep workspaceId={currentWorkspaceId} />
          )}
          {step === 3 && currentWorkspaceId && (
            <ConnectPostHogStep workspaceId={currentWorkspaceId} />
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            disabled={step === 0}
            className={step === 0 ? 'invisible' : ''}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back
          </Button>
          <Button onClick={handlePrimary} disabled={!canAdvance}>
            {isLast ? (
              'Finish'
            ) : (
              <>
                {nextLabel}
                <ArrowRight className="ml-1 h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
