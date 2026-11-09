import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';

import { Button, Card, Label, SectionHeader } from '../../../src/components/UI';
import { useAuth, useMobileRuntime, useNetwork, useWorkspace } from '../../../src/auth/AuthProvider';
import { Status } from '../../../src/components/AuthControls';
import { ShellScreen, ShellText } from '../../../src/components/ShellScreen';
import { NotificationSettings } from '../../../src/notifications/Settings';

export default function SettingsScreen() {
  const auth = useAuth();
  const { account, auth: controller, notifications, signOut } = useMobileRuntime();
  const workspace = useWorkspace();
  const router = useRouter();
  const offline = useNetwork() === 'offline';
  const [showId, setShowId] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
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
  return <ShellScreen topInset title="Settings" description="Make Talyn work for you.">
    <Card><SectionHeader title="Account" />
    <ShellText>{auth.user?.email ?? 'GitHub account'}</ShellText>
    <Button variant="quiet" title={showId ? 'Hide account ID' : 'Show account ID'} onPress={() => setShowId(!showId)} />
    {showId ? <Label muted small>Account ID: {auth.user?.id}</Label> : null}
    <Button variant="secondary" title="Sign out" disabled={deleting} onPress={() => { void (signOut ? signOut() : controller.signOut()); }} />
    </Card>
    <Card><SectionHeader title="Workspace" />
    <ShellText>Workspace: {workspace.choices.find((choice) => choice.id === workspace.selected)?.name ?? 'None selected'}</ShellText>
    {auth.issue === 'outage' ? <Status message="Sign-in is temporarily unavailable. Your account is still signed in." /> : null}
    {offline ? <Status message="You are offline. Account deletion needs an internet connection." /> : null}
    <Button variant="secondary" title="Choose workspace" disabled={deleting} onPress={() => router.push('/workspaces')} />
    </Card>
    {notifications ? <NotificationSettings controller={notifications} offline={offline} /> : null}
    <Card><SectionHeader title="Delete account" detail="This action is permanent." />
    <ShellText>Account deletion removes owned workspaces. Backups, billing records, and external provider records can remain.</ShellText>
    {deleting ? <Status message="Deleting your account" loading /> : null}
    {result ? <Status message={result} /> : null}
    <Button title="Delete account" accessibilityLabel="Delete Talyn account" variant="destructive" disabled={deleting || offline} onPress={confirmDeletion} />
    </Card>
  </ShellScreen>;
}
