import type { WatchedRepo } from '@talyn/client/native';
import type { WorkbenchReadiness } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { useWorkspaceName } from '../../components/ScreenHeader';
import { AppText, Button } from '../../components/UI';
import { trackEvent } from '../../lib/analytics';
import { agentReady } from '../../navigation/onboardingGate';
import { featureOffered, useFeatures } from '../../lib/features';
import { display, radius, sans, useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { NewWorkScreen } from '../create/NewWorkScreen';
import { nothingConnected } from '../onboarding/readiness';
import { ConnectAgentSheet } from '../agents/connect/ConnectAgentSheet';
import { ConnectAgentModal, ReadinessChecklist } from '../onboarding/ReadinessChecklist';
import { PullRequestsScreen } from '../prs/PullRequestsScreen';
import { useActiveContext } from '../spaces/context';

/** Which home to draw: web shows its Welcome until a repository exists, and mobile also while no agent is connected. */
export function homeView(input: { repositories: readonly unknown[] | undefined; readiness: WorkbenchReadiness | undefined; inSpace: boolean }):
  'composer' | 'welcome' {
  if (input.inSpace) return 'composer';
  if (input.repositories && input.repositories.length === 0) return 'welcome';
  return nothingConnected(input.readiness) ? 'welcome' : 'composer';
}

/**
 * Home, like web's landing page: the new-session composer. An account
 * without sessions gets its pull request lists instead, and an account with
 * nothing set up gets the welcome checklist.
 */
export function HomeScreen() {
  const features = useFeatures();
  const offered = features === null || featureOffered(features, 'workbenches');
  const repositories = useResource<WatchedRepo[]>('repositories', '', offered);
  const readiness = useResource<WorkbenchReadiness>('readiness', '', offered);
  const inSpace = Boolean(useActiveContext().active?.space);
  if (!offered) return <PullRequestsScreen tab="mine" />;
  const notice = agentNoticeVisible(readiness.status, readiness.data);
  const welcome = homeView({ repositories: repositories.data, readiness: readiness.data, inSpace }) === 'welcome';
  return <View style={styles.fill}>
    {notice ? <ConnectAgentNotice /> : null}
    {welcome
      ? <HomeWelcome hasRepositories={(repositories.data?.length ?? 0) > 0} readiness={readiness.data} noticeShown={notice} />
      : <NewWorkScreen presentation="home" />}
  </View>;
}

/** The notice shows once readiness loaded, no agent is ready, and the fleet is usable (otherwise no connection helps). */
export function agentNoticeVisible(status: string, readiness: WorkbenchReadiness | undefined): boolean {
  return status === 'ready' && Boolean(readiness) && readiness?.sandbox.ok !== false && !agentReady(readiness);
}

/** A permanent card, shown until an agent is connected. */
export function ConnectAgentNotice() {
  const c = useTheme();
  const { workflow } = useMobileRuntime();
  const [connecting, setConnecting] = useState(false);
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    trackEvent('connect_agent_banner_viewed');
  }, []);
  return <View style={[styles.notice, { backgroundColor: c.surface, borderColor: c.border }]}>
    <Text accessibilityRole="header" style={[styles.noticeTitle, { color: c.text }]}>Connect an agent to start sessions</Text>
    <AppText variant="meta" tone="muted">
      Talyn shows your pull requests now. To start a session, fix a pull request or review code, connect your Claude or ChatGPT subscription.
    </AppText>
    <View style={styles.noticeAction}>
      <Button size="sm" title="Connect an agent" onPress={() => { trackEvent('connect_agent_banner_clicked'); setConnecting(true); }} />
    </View>
    <ConnectAgentSheet visible={connecting} onClose={() => setConnecting(false)}
      onConnected={() => { workflow.refresh('readiness'); workflow.refresh('providers'); }} />
  </View>;
}

/** Web's Welcome: add a repository, then the sandbox and agent checklist with each fix. */
function HomeWelcome({ hasRepositories, readiness, noticeShown }: {
  hasRepositories: boolean; readiness: WorkbenchReadiness | undefined; noticeShown: boolean;
}) {
  const c = useTheme();
  const router = useRouter();
  const [connecting, setConnecting] = useState(false);
  return <ScrollView contentContainerStyle={styles.page} style={{ backgroundColor: c.background }}>
    <View style={styles.hero}>
      <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>Welcome to Talyn</Text>
      <AppText variant="body" tone="muted" style={styles.center}>
        {hasRepositories ? 'Connect your Claude or ChatGPT subscription to start a session.'
          : 'Add a repository to start a session. Each session has an agent chat and its changes.'}
      </AppText>
    </View>
    <View style={styles.actions}>
      {hasRepositories ? (noticeShown ? null : <Button title="Connect an agent" onPress={() => setConnecting(true)} />)
        : <Button title="Add repository" icon={{ ios: 'folder.badge.plus', android: 'create_new_folder' }} onPress={() => router.push('/repositories')} />}
    </View>
    <ReadinessChecklist readiness={readiness} />
    <ConnectAgentModal visible={connecting} onClose={() => setConnecting(false)} />
  </ScrollView>;
}

/** The home header's title: the active space, or the workspace name. */
export function HomeTitle() {
  const c = useTheme();
  const name = useWorkspaceName();
  const space = useActiveContext().active?.space.name;
  return <Text accessibilityRole="header" numberOfLines={1} style={[styles.headerTitle, { color: c.text }]}>{space ?? name ?? 'Talyn'}</Text>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  notice: { gap: 8, margin: 12, padding: 14, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  noticeTitle: { fontSize: 15, lineHeight: 20, ...sans(600) },
  noticeAction: { alignSelf: 'flex-start' },
  headerTitle: { fontSize: 16, lineHeight: 22, ...sans(600) },
  page: { flexGrow: 1, justifyContent: 'center', gap: 20, paddingHorizontal: 20, paddingVertical: 32, width: '100%', maxWidth: 480, alignSelf: 'center' },
  hero: { alignItems: 'center', gap: 8 },
  title: { fontSize: 24, lineHeight: 30, letterSpacing: -0.3, ...display(600) },
  center: { textAlign: 'center' },
  actions: { alignItems: 'center' },
});
