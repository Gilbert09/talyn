import type { Workspace } from '@talyn/shared';
import { useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, View } from 'react-native';

import { useAuth, useMobileRuntime, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { Status } from '../../components/AuthControls';
import { ScreenContainer } from '../../components/ScreenContainer';
import { useWorkspaceName } from '../../components/ScreenHeader';
import { AppText, Button, Group, Row, Segmented, useActionSheet } from '../../components/UI';
import { openExternal } from '../../components/Workflow';
import { useFeatures } from '../../lib/features';
import { NotificationSettings } from '../../notifications/Settings';
import { radius, setThemePreference, useTheme, useThemePreference } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { AboutUpdates } from '../updates/AboutUpdates';
import { useBillingStatus } from '../usage/data';
import { appInfo, DOCS_URL, WEB_APP_URL } from './about';
import { AnalyticsSetting } from './AnalyticsSetting';
import { APPEARANCE_OPTIONS, billingLine, githubStateLabel, githubStateOf, settingsEditorLinks } from './model';
import { SessionSettings } from './SessionSettings';

export function SettingsScreen() {
  const auth = useAuth();
  const { account, auth: controller, notifications, signOut } = useMobileRuntime();
  const selected = useWorkspace().selected;
  const workspaceName = useWorkspaceName();
  const workspace = useResource<Workspace>('workspace', '', Boolean(selected));
  const features = useFeatures();
  const billing = useBillingStatus();
  const offline = useNetwork() === 'offline';
  const theme = useThemePreference();
  const sheet = useActionSheet();
  const [showId, setShowId] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const info = appInfo();
  const current = selected && workspace.data?.id === selected ? workspace.data : null;
  const github = githubStateOf(current);
  const plan = billingLine(billing.data);
  const confirmDeletion = () => Alert.alert('Delete your Talyn account?',
    'This removes your Talyn account and owned workspaces. You cannot undo this action. Some backups and provider records can remain.', [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Delete account', style: 'destructive', onPress: () => {
        setDeleting(true);
        void account.deleteAccount().then((value) => {
          setDeleting(false);
          setResult(value === 'blocked' ? 'Deletion is blocked because you are the last administrator of a paying team. Add another administrator or cancel the team subscription in Talyn on the web.'
            : value === 'deleted' ? 'Your account was deleted.' : 'Deletion could not finish. Please try again. Contact Talyn support if the problem continues.');
        });
      } },
    ]);
  const editors = selected ? settingsEditorLinks(features) : [];
  return <ScreenContainer>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Group title="Account">
        <Row title={auth.user?.email ?? 'GitHub account'} subtitle="Signed in with GitHub" />
        <Row title={showId ? 'Hide account ID' : 'Show account ID'} onPress={() => setShowId(!showId)}>
          {showId ? <AppText selectable variant="meta" tone="muted">Account ID: {auth.user?.id}</AppText> : null}
        </Row>
        <AnalyticsSetting divider />
        <Row title="Sign out" disabled={deleting} divider={false} onPress={() => { void (signOut ? signOut() : controller.signOut()); }} />
      </Group>
      <Group title="Workspace">
        <Row title={workspaceName ?? 'No workspace selected'} subtitle="Current workspace" chevron href="/workspaces"
          leading={current ? <WorkspaceLogo workspace={current} /> : undefined}
          accessibilityLabel={`Change workspace. Selected: ${workspaceName ?? 'none'}.`} disabled={deleting} divider={Boolean(selected)} />
        {selected ? <>
          <Row title="Repositories" subtitle="Watched repositories and box sizes" chevron href="/repositories" />
          <Row title="GitHub" subtitle={github === 'connected' ? 'Manage the GitHub App and its access' : 'Connect GitHub to watch repositories'}
            chevron href={github === 'connected' ? '/repositories' : '/onboarding/github'}
            trailing={github === 'unknown' ? undefined : <AppText variant="meta" tone={github === 'connected' ? 'success' : 'warning'}>{githubStateLabel(github)}</AppText>}
            accessibilityLabel={`GitHub. ${githubStateLabel(github) || 'Status unknown'}.`} />
          <Row title="Agents" subtitle="Connect Claude or Codex" chevron href="/agents" divider={false} />
        </> : null}
      </Group>
      <Group title="Plan and billing">
        <Row title="Plan and billing" subtitle={plan ?? 'Plan, box-hours and credits'} chevron href="/billing" divider={false} />
      </Group>
      {current ? <SessionSettings workspace={current} offline={offline} openSheet={sheet.open} refresh={workspace.refresh} /> : null}
      {editors.length ? <Group title="Agents and tools">
        {editors.map((link, index) => <Row key={link.key} title={link.title} subtitle={link.subtitle} href={link.href} chevron
          divider={index < editors.length - 1} />)}
      </Group> : null}
      <Group title="Appearance" footer="Applies to this device.">
        <View style={styles.block}>
          <Segmented options={APPEARANCE_OPTIONS} value={theme} onChange={(value) => setThemePreference(value)} accessibilityLabel="Theme" />
        </View>
      </Group>
      {auth.issue === 'outage' ? <Status message="Sign-in is temporarily unavailable. Your account is still signed in." /> : null}
      {notifications ? <NotificationSettings controller={notifications} offline={offline} /> : null}
      <Group title="About">
        <Row title="Version" trailing={<AppText variant="meta" tone="muted" selectable>{info.build ? `${info.version} (${info.build})` : info.version}</AppText>} />
        <AboutUpdates info={info} />
        <Row title="Open Talyn on the web" chevron onPress={() => openExternal(WEB_APP_URL)} />
        <Row title="Help and documentation" chevron divider={false} onPress={() => openExternal(DOCS_URL)} />
      </Group>
      <Group title="Delete account" footer="Account deletion removes owned workspaces. Backups, billing records, and external provider records can remain.">
        <View style={styles.block}>
          {offline ? <Status message="You are offline. Account deletion needs an internet connection." /> : null}
          {deleting ? <Status message="Deleting your account" loading /> : null}
          {result ? <Status message={result} /> : null}
          <Button title="Delete account" accessibilityLabel="Delete Talyn account" variant="destructive" size="sm" disabled={deleting || offline} onPress={confirmDeletion} />
        </View>
      </Group>
    </ScrollView>
    {sheet.sheet}
  </ScreenContainer>;
}

/** The workspace's uploaded logo, or its first letter. Identicons are drawn on the web only. */
function WorkspaceLogo({ workspace }: { workspace: Workspace }) {
  const c = useTheme();
  if (workspace.logo?.kind === 'image') {
    return <Image accessibilityIgnoresInvertColors source={{ uri: workspace.logo.dataUrl }} style={styles.logo} />;
  }
  return <View style={[styles.logo, { backgroundColor: c.surface }]}>
    <AppText variant="caption" tone="muted">{workspace.name.trim().charAt(0).toUpperCase() || 'W'}</AppText>
  </View>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40, gap: 16, width: '100%', maxWidth: 680, alignSelf: 'center' },
  block: { gap: 10, paddingVertical: 12 },
  logo: { width: 28, height: 28, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
