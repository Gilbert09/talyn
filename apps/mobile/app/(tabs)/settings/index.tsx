import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Button } from 'react-native';

import { useAuth, useMobileRuntime, useNetwork, useWorkspace } from '../../../src/auth/AuthProvider';
import { Status } from '../../../src/components/AuthControls';
import { ShellScreen, ShellText } from '../../../src/components/ShellScreen';

export default function SettingsScreen() {
  const auth = useAuth();
  const { account, auth: controller } = useMobileRuntime();
  const workspace = useWorkspace();
  const router = useRouter();
  const offline = useNetwork() === 'offline';
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
  return <ShellScreen title="Settings" description="Manage your Talyn account.">
    <ShellText>{auth.user?.email ?? 'GitHub account'}</ShellText>
    <ShellText>Account ID: {auth.user?.id}</ShellText>
    <ShellText>Workspace: {workspace.choices.find((choice) => choice.id === workspace.selected)?.name ?? 'None selected'}</ShellText>
    {auth.issue === 'outage' ? <Status message="Sign-in is temporarily unavailable. Your account is still signed in." /> : null}
    {offline ? <Status message="You are offline. Account deletion needs an internet connection." /> : null}
    <Button title="Choose workspace" disabled={deleting} onPress={() => router.push('/workspaces')} />
    <Button title="Sign out" disabled={deleting} onPress={() => { void controller.signOut(); }} />
    <ShellText>Account deletion removes owned workspaces. Backups, billing records, and external provider records can remain.</ShellText>
    {deleting ? <Status message="Deleting your account" loading /> : null}
    {result ? <Status message={result} /> : null}
    <Button title="Delete account" accessibilityLabel="Delete Talyn account" color="#b42318" disabled={deleting || offline} onPress={confirmDeletion} />
  </ShellScreen>;
}
