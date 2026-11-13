import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { useWorkspaceStore } from '../../stores/workspace';
import { useGithubConnection } from '../../hooks/useGithubConnection';
import { trackEvent } from '../../lib/analytics';
import { FirstSessionStep } from './steps/FirstSessionStep';
import { ConnectAgentStep } from './steps/ConnectAgentStep';
import { ConnectGitHubStep } from './steps/ConnectGitHubStep';
import { WatchReposStep } from './steps/WatchReposStep';
import { SourceSurvey, type SignupSource } from './SourceSurvey';
import { useNavigationStore } from '../../stores/navigation';
import { sessionAgentConnected } from '../../lib/agentConnection';

const GITHUB_POLL_MS = 4000;

const STEPS = [
  { key: 'github', title: 'Connect GitHub' },
  { key: 'repos', title: 'Choose where your agent will work.' },
  { key: 'agent', title: 'Connect your agent' },
  { key: 'first_session', title: 'Start your first session' },
] as const;

/** Connect GitHub, choose repositories, and connect an agent before starting a session. */
export function OnboardingWizard() {
  const { currentWorkspaceId, repositories, cloudProviders, posthogStatus, setOnboardingComplete, setJustOnboarded } =
    useWorkspaceStore();
  // The browser round trip can finish without a focus event reaching the app,
  // so the GitHub step also re-checks every few seconds until it connects.
  const { status, user } = useGithubConnection(currentWorkspaceId, { pollMs: GITHUB_POLL_MS });
  const navigate = useNavigationStore((s) => s.navigate);
  const [step, setStep] = useState(0);
  const [creatingSession, setCreatingSession] = useState(false);
  const viewedStep = useRef<string | null>(null);
  const reportedAgents = useRef(new Set<string>());
  const [signupSource, setSignupSource] = useState<SignupSource | null>(null);
  const latestSignupSource = useRef<SignupSource | null>(null);

  useEffect(() => {
    setOnboardingComplete(false);
  }, [setOnboardingComplete]);

  useEffect(() => {
    const key = STEPS[step].key;
    if (viewedStep.current === key) return;
    viewedStep.current = key;
    trackEvent('onboarding_step_viewed', { step: key });
  }, [step]);

  function handleSourceSelect(source: SignupSource) {
    latestSignupSource.current = source;
    setSignupSource(source);
    trackEvent('signup_source_survey', { signup_source: source });
  }

  const githubConnected = Boolean(status?.connected);
  const fleet = cloudProviders?.find((provider) => provider.type === 'selfhosted');
  const claudeConnected = fleet?.connectedAgents?.includes('claude') ?? false;
  const codexConnected = fleet?.connectedAgents?.includes('codex') ?? false;
  const posthogConnected = posthogStatus?.connected === true;
  const agentConnected = claudeConnected || codexConnected || posthogConnected;
  const canStartSessions = sessionAgentConnected(cloudProviders, posthogConnected);

  useEffect(() => {
    if (step !== 2) return;
    const connections = { claude: claudeConnected, codex: codexConnected, posthog_code: posthogConnected };
    for (const [vendor, connected] of Object.entries(connections)) {
      if (!connected || reportedAgents.current.has(vendor)) continue;
      reportedAgents.current.add(vendor);
      trackEvent('onboarding_agent_connected', { vendor });
    }
  }, [step, claudeConnected, codexConnected, posthogConnected]);

  const canAdvance = step === 0 ? githubConnected : step === 1 ? repositories.length > 0 : canStartSessions;
  const isLast = step === STEPS.length - 1;
  const blockedHint = canAdvance
    ? null
    : step === 0
      ? 'Connect GitHub and install the Talyn GitHub App on at least one account to continue.'
      : step === 1
        ? 'Choose at least one repository to continue.'
        : step === 2
          ? cloudProviders && !fleet
            ? 'Connect PostHog Code to start sessions, or skip for now.'
            : 'Connect Claude or ChatGPT to start sessions, or skip for now.'
          : null;

  function finishOnboarding({ agentSkipped = false }: { agentSkipped?: boolean } = {}) {
    trackEvent('onboarding_completed', {
      github_connected: githubConnected,
      repos_watched: repositories.length,
      agent_connected: agentConnected,
      agent_skipped: agentSkipped,
      // The answer can change while the session request is pending.
      signup_source: latestSignupSource.current,
    });
    setJustOnboarded(true);
    setOnboardingComplete(true);
  }

  function handlePrimary() {
    if (!canAdvance || isLast) return;
    trackEvent('onboarding_step_completed', { step: STEPS[step].key });
    setStep((s) => s + 1);
  }

  function handleSessionCreated() {
    trackEvent('first_session_created', { from: 'onboarding' });
    trackEvent('onboarding_step_completed', { step: 'first_session' });
    finishOnboarding();
  }

  function handleSkip() {
    trackEvent('onboarding_first_session_skipped');
    navigate({ view: 'home' }, { replace: true });
    finishOnboarding();
  }

  // The first-session step needs an agent, so a skip here ends onboarding.
  function handleSkipAgent() {
    trackEvent('onboarding_agent_skipped');
    navigate({ view: 'home' }, { replace: true });
    finishOnboarding({ agentSkipped: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-6 rounded-lg border bg-card p-6">
        <div className="space-y-1 text-center">
          <h1 className="font-display text-base font-semibold tracking-tight">Welcome to Talyn</h1>
          <p className="text-[13px] text-muted-foreground">Let's get your workspace set up.</p>
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
          <h2 className="mb-3 text-base font-semibold">
            {STEPS[step].title}
          </h2>

          {step === 0 && (
            <ConnectGitHubStep workspaceId={currentWorkspaceId} status={status} user={user} />
          )}
          {step === 1 && currentWorkspaceId && (
            <WatchReposStep workspaceId={currentWorkspaceId} />
          )}
          {step === 2 && <ConnectAgentStep />}
          {isLast && (
            <FirstSessionStep
              onCreated={handleSessionCreated}
              onSkip={handleSkip}
              onBusyChange={setCreatingSession}
            />
          )}

          {isLast && (
            <div className="mt-4">
              <SourceSurvey value={signupSource} onSelect={handleSourceSelect} />
            </div>
          )}
        </div>

        {blockedHint && (
          <p className="text-center text-[13px] text-muted-foreground" role="status">
            {blockedHint}
          </p>
        )}
        {step === 2 && !canAdvance && (
          <div className="-mt-4 text-center">
            <button
              type="button"
              onClick={handleSkipAgent}
              className="text-[13px] font-medium text-foreground underline-offset-4 hover:underline"
            >
              Skip for now
            </button>
          </div>
        )}

        {/* Footer nav */}
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            disabled={step === 0 || creatingSession}
            className={step === 0 ? 'invisible' : ''}
          >
            <ArrowLeft className="mr-1 h-3.5 w-3.5" />
            Back
          </Button>
          {!isLast && (
            <Button onClick={handlePrimary} disabled={!canAdvance}>
              Next
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
