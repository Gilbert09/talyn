import { Redirect, router, type Href } from 'expo-router';
import { useEffect, type PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

import { useMobileRuntime, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Button } from '../../components/UI';
import { AppLoading } from '../../navigation/AppLoading';
import { agentReady, type OnboardingStep } from '../../navigation/onboardingGate';
import { HOME } from '../../navigation/routes';
import { useOnboardingGate } from '../../navigation/useOnboardingGate';
import { workspaceGate } from '../../navigation/workspaceGate';
import { ConnectAgentPanel } from '../agents/connect/ConnectAgentSheet';
import { RepositoriesPanel } from '../repositories/RepositoriesScreen';
import { ConnectGitHubStep } from './ConnectGitHubStep';
import { useGithubConnection } from './githubFlow';
import { OnboardingShell } from './OnboardingShell';
import { useOnboardingProgress } from './progress';
import { ReadinessChecklist } from './ReadinessChecklist';

export const stepRoute = (step: OnboardingStep): Href => `/onboarding/${step}` as Href;
const PREVIOUS: Record<OnboardingStep, OnboardingStep | null> = { github: null, repos: 'github', agent: 'repos' };

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

function Footer({ step, next, nextLabel = 'Next', canAdvance, skip }: {
  step: OnboardingStep; next(): void; nextLabel?: string; canAdvance: boolean; skip?(): void;
}) {
  return <>
    <View style={styles.side}>
      {PREVIOUS[step] ? <Button variant="quiet" title="Back" icon={{ ios: 'chevron.left', android: 'arrow_back' }} onPress={() => back(step)} /> : null}
    </View>
    <View style={[styles.side, styles.end]}>
      {skip ? <Button variant="quiet" title="Skip for now" onPress={skip} /> : null}
      <Button title={nextLabel} disabled={!canAdvance} onPress={next} />
    </View>
  </>;
}

export function GithubStepScreen() {
  const workspace = useWorkspace().selected as string;
  const connection = useGithubConnection(workspace);
  const { workspace: resource } = useOnboardingGate();
  const connected = connection.connected || Boolean(resource.data?.integrations?.github);
  return <OnboardingShell step="github" footer={<Footer step="github" canAdvance={connected} next={() => router.push(stepRoute('repos'))} />}>
    <ConnectGitHubStep workspaceId={workspace} connection={connection} />
  </OnboardingShell>;
}

export function ReposStepScreen() {
  const workspace = useWorkspace().selected as string;
  const { repositories } = useOnboardingGate();
  const count = repositories.data?.length ?? 0;
  return <OnboardingShell step="repos" footer={<Footer step="repos" canAdvance={count > 0} next={() => router.push(stepRoute('agent'))} />}>
    <RepositoriesPanel workspaceId={workspace} />
  </OnboardingShell>;
}

export function AgentStepScreen() {
  const { readiness } = useOnboardingGate();
  const { finish } = useOnboardingProgress();
  const { workflow } = useMobileRuntime();
  const ready = agentReady(readiness.data);
  const done = () => { finish(); router.replace(HOME); };
  return <OnboardingShell step="agent" footer={<Footer step="agent" nextLabel="Start using Talyn" canAdvance={ready} next={done} skip={ready ? undefined : done} />}>
    <AppText variant="meta" tone="muted">Use your Claude or ChatGPT subscription. Sessions run on your own plan.</AppText>
    <ConnectAgentPanel onConnected={() => { workflow.refresh('readiness'); workflow.refresh('providers'); }} />
    <ReadinessChecklist readiness={readiness.data} />
  </OnboardingShell>;
}

const styles = StyleSheet.create({
  side: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  end: { justifyContent: 'flex-end', flexShrink: 1 },
});
