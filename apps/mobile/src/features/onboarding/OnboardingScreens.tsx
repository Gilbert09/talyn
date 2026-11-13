import { Redirect, router, type Href } from 'expo-router';
import { useEffect, type PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Button } from '../../components/UI';
import { trackEvent } from '../../lib/analytics';
import { AppLoading } from '../../navigation/AppLoading';
import { agentReady, agentStepSkippable, type OnboardingStep } from '../../navigation/onboardingGate';
import { HOME } from '../../navigation/routes';
import { useOnboardingGate } from '../../navigation/useOnboardingGate';
import { workspaceGate } from '../../navigation/workspaceGate';
import { ConnectAgentPanel } from '../agents/connect/ConnectAgentSheet';
import { RepositoriesPanel } from '../repositories/RepositoriesScreen';
import { ConnectGitHubStep } from './ConnectGitHubStep';
import { useGithubConnection } from './githubFlow';
import { enableNotifications, notificationStepAction, NotificationsStep, useNotificationSnapshot } from './NotificationsStep';
import { OnboardingShell } from './OnboardingShell';
import { useOnboardingProgress } from './progress';
import { ReadinessChecklist } from './ReadinessChecklist';

export const stepRoute = (step: OnboardingStep): Href => `/onboarding/${step}` as Href;
const PREVIOUS: Record<OnboardingStep, OnboardingStep | null> = { github: null, repos: 'github', agent: 'repos', notifications: 'agent' };

/**
 * The onboarding stack waits for a workspace like home does, and records that
 * onboarding started on this device, so a restart resumes it.
 */
export function OnboardingGuard({ children }: PropsWithChildren) {
  const workspace = useWorkspace();
  const gate = workspaceGate(workspace);
  const { start } = useOnboardingProgress();
  useEffect(() => { if (gate === 'ready') start(); }, [gate, start]);
  if (gate === 'wait') return <AppLoading phase="workspace" />;
  if (gate === 'choose') return <Redirect href="/workspaces" />;
  return <>{children}</>;
}

/** `/onboarding` opens the first step still open. */
export function OnboardingIndex() {
  const { gate } = useOnboardingGate();
  if (gate === 'loading') return <AppLoading phase="workspace" />;
  return <Redirect href={gate === 'done' ? HOME : stepRoute(gate)} />;
}

function back(step: OnboardingStep) {
  const previous = PREVIOUS[step];
  if (router.canGoBack()) router.back();
  else if (previous) router.replace(stepRoute(previous));
}

function Footer({ step, next, nextLabel = 'Next', canAdvance, skip, loading = false }: {
  step: OnboardingStep; next(): void; nextLabel?: string; canAdvance: boolean; skip?(): void; loading?: boolean;
}) {
  return <>
    <View style={styles.side}>
      {PREVIOUS[step] ? <Button variant="quiet" title="Back" icon={{ ios: 'chevron.left', android: 'arrow_back' }} onPress={() => back(step)} /> : null}
    </View>
    <View style={[styles.side, styles.end]}>
      {skip ? <Button variant="quiet" title="Skip for now" onPress={skip} /> : null}
      <Button title={nextLabel} disabled={!canAdvance || loading} loading={loading} onPress={next} />
    </View>
  </>;
}

/** Web's `onboarding_step_completed`, with the same step keys. */
function completed(step: OnboardingStep) { trackEvent('onboarding_step_completed', { step }); }

export function GithubStepScreen() {
  const workspace = useWorkspace().selected as string;
  const connection = useGithubConnection(workspace);
  const { workspace: resource } = useOnboardingGate();
  const connected = connection.connected || Boolean(resource.data?.integrations?.github);
  return <OnboardingShell step="github" footer={<Footer step="github" canAdvance={connected} next={() => { completed('github'); router.push(stepRoute('repos')); }} />}>
    <ConnectGitHubStep workspaceId={workspace} connection={connection} />
    {connected ? null : <AppText variant="meta" tone="muted">Connect GitHub and install the Talyn GitHub App on at least one account to continue.</AppText>}
  </OnboardingShell>;
}

export function ReposStepScreen() {
  const workspace = useWorkspace().selected as string;
  const { repositories } = useOnboardingGate();
  const count = repositories.data?.length ?? 0;
  return <OnboardingShell step="repos" footer={<Footer step="repos" canAdvance={count > 0} next={() => { completed('repos'); router.push(stepRoute('agent')); }} />}>
    <RepositoriesPanel workspaceId={workspace} />
    {count > 0 ? null : <AppText variant="meta" tone="muted">Choose at least one repository to continue.</AppText>}
  </OnboardingShell>;
}

export function AgentStepScreen() {
  const { readiness, repositories } = useOnboardingGate();
  const { finish } = useOnboardingProgress();
  const { workflow } = useMobileRuntime();
  const ready = agentReady(readiness.data);
  const fleetDown = agentStepSkippable(readiness.data);
  const next = () => { completed('agent'); router.push(stepRoute('notifications')); };
  // Skipping ends onboarding on this device and goes home, where a notice asks for an agent.
  const skip = () => {
    trackEvent('onboarding_agent_skipped', { github_connected: true, repos_watched: repositories.data?.length ?? 0, fleet_usable: !fleetDown });
    finish();
    router.replace(HOME);
  };
  return <OnboardingShell step="agent" footer={<Footer step="agent" canAdvance={ready} next={next} skip={ready ? undefined : skip} />}>
    <AppText variant="meta" tone="muted">Use your Claude or ChatGPT subscription. Sessions run on your own plan.</AppText>
    <ConnectAgentPanel onChoose={(agent) => trackEvent('onboarding_agent_option_selected', { agent })}
      onConnected={() => { workflow.refresh('readiness'); workflow.refresh('providers'); }} />
    <ReadinessChecklist readiness={readiness.data} />
    {ready ? null : <AppText variant="meta" tone="muted">You need a connected agent to start sessions. You can connect one later.</AppText>}
  </OnboardingShell>;
}

/** The optional last step. Skip and finish both open home; only an agent connection counts as a completed setup. */
export function NotificationsStepScreen() {
  const { readiness, repositories } = useOnboardingGate();
  const { finish } = useOnboardingProgress();
  const { notifications } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const snapshot = useNotificationSnapshot(notifications);
  const action = notificationStepAction(snapshot, offline);
  const done = () => {
    const enabled = snapshot.state === 'ready';
    if (enabled) completed('notifications');
    if (agentReady(readiness.data)) {
      trackEvent('onboarding_completed', { github_connected: true, repos_watched: repositories.data?.length ?? 0, agent_connected: true,
        notifications_enabled: enabled });
    }
    finish();
    router.replace(HOME);
  };
  const footer = action === 'finish'
    ? <Footer step="notifications" nextLabel="Start using Talyn" canAdvance next={done} />
    : <Footer step="notifications" nextLabel="Turn on notifications" canAdvance loading={snapshot.state === 'loading'}
      next={() => { void enableNotifications(notifications); }} skip={done} />;
  return <OnboardingShell step="notifications" footer={footer}>
    <NotificationsStep controller={notifications} offline={offline} />
  </OnboardingShell>;
}

const styles = StyleSheet.create({
  side: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  end: { justifyContent: 'flex-end', flexShrink: 1 },
});
