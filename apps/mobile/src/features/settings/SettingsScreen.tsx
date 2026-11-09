import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { useAuth, useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { Status } from '../../components/AuthControls';
import { ScreenContainer } from '../../components/ScreenContainer';
import { useWorkspaceName } from '../../components/ScreenHeader';
import { AppText, Button, Group, Row } from '../../components/UI';
import { Heading, openExternal } from '../../components/Workflow';
import { NotificationSettings } from '../../notifications/Settings';
import { appInfo, DOCS_URL, WEB_APP_URL } from './about';

export function SettingsScreen() {
  const auth = useAuth();
  const { account, auth: controller, notifications, signOut } = useMobileRuntime();
  const workspaceName = useWorkspaceName();
  const offline = useNetwork() === 'offline';
  const [showId, setShowId] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const info = appInfo();
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
  return <ScreenContainer topInset>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Heading>Settings</Heading>
      <Group title="Account">
        <Row title={auth.user?.email ?? 'GitHub account'} subtitle="Signed in with GitHub" />
        <Row title={showId ? 'Hide account ID' : 'Show account ID'} onPress={() => setShowId(!showId)}>
          {showId ? <AppText selectable variant="meta" tone="muted">Account ID: {auth.user?.id}</AppText> : null}
        </Row>
        <Row title="Sign out" disabled={deleting} divider={false} onPress={() => { void (signOut ? signOut() : controller.signOut()); }} />
      </Group>
      <Group title="Workspace">
        <Row title={workspaceName ?? 'No workspace selected'} subtitle="Current workspace" divider={false} chevron href="/workspaces"
          accessibilityLabel={`Change workspace. Selected: ${workspaceName ?? 'none'}.`} disabled={deleting} />
      </Group>
      {auth.issue === 'outage' ? <Status message="Sign-in is temporarily unavailable. Your account is still signed in." /> : null}
      {notifications ? <NotificationSettings controller={notifications} offline={offline} /> : null}
      <Group title="About">
        <Row title="Version" trailing={<AppText variant="meta" tone="muted" selectable>{info.build ? `${info.version} (${info.build})` : info.version}</AppText>} />
        {info.channel || info.runtime ? <Row title="Update channel" trailing={<AppText variant="meta" tone="muted" selectable>
          {[info.channel, info.runtime ? `runtime ${info.runtime}` : null, info.update].filter(Boolean).join(' · ')}</AppText>} /> : null}
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
  </ScreenContainer>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40, gap: 16, width: '100%', maxWidth: 680, alignSelf: 'center' },
  block: { gap: 10, paddingVertical: 12 },
});
