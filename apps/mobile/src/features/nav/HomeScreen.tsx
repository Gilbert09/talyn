import type { WatchedRepo } from '@talyn/client/native';
import type { WorkbenchReadiness } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useWorkspaceName } from '../../components/ScreenHeader';
import { AppText, Button } from '../../components/UI';
import { featureOffered, useFeatures } from '../../lib/features';
import { display, sans, useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { NewWorkScreen } from '../create/NewWorkScreen';
import { nothingConnected } from '../onboarding/readiness';
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
  if (homeView({ repositories: repositories.data, readiness: readiness.data, inSpace }) === 'welcome') {
    return <HomeWelcome hasRepositories={(repositories.data?.length ?? 0) > 0} readiness={readiness.data} />;
  }
  return <NewWorkScreen presentation="home" />;
}

/** Web's Welcome: add a repository, then the sandbox and agent checklist with each fix. */
function HomeWelcome({ hasRepositories, readiness }: { hasRepositories: boolean; readiness: WorkbenchReadiness | undefined }) {
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
      {hasRepositories ? <Button title="Connect an agent" onPress={() => setConnecting(true)} />
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
  headerTitle: { fontSize: 16, lineHeight: 22, ...sans(600) },
  page: { flexGrow: 1, justifyContent: 'center', gap: 20, paddingHorizontal: 20, paddingVertical: 32, width: '100%', maxWidth: 480, alignSelf: 'center' },
  hero: { alignItems: 'center', gap: 8 },
  title: { fontSize: 24, lineHeight: 30, letterSpacing: -0.3, ...display(600) },
  center: { textAlign: 'center' },
  actions: { alignItems: 'center' },
});
