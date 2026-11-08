import { useRouter } from 'expo-router';
import { Button, View } from 'react-native';

import { consumeIntent } from '../src/navigation/intents';
import { useAuth, useMobileRuntime, useNetwork, useWorkspace } from '../src/auth/AuthProvider';
import { Status } from '../src/components/AuthControls';
import { ShellScreen, ShellText } from '../src/components/ShellScreen';

export default function WorkspacesScreen() {
  const state = useWorkspace();
  const { workspace, auth: controller } = useMobileRuntime();
  const user = useAuth().user;
  const offline = useNetwork() === 'offline';
  const router = useRouter();
  return <ShellScreen title="Choose a workspace" description="Choose a workspace that your account can access.">
    {state.status === 'loading' || state.status === 'idle' ? <Status message="Loading workspaces" loading /> : null}
    {offline ? <Status message="You are offline. Connect to the internet to check workspace access." /> : null}
    {state.status === 'error' ? <><Status message="Workspaces could not load. Please try again." />
      <Button title="Try again" disabled={offline} onPress={() => { if (user) void workspace.load(user.id); }} /></> : null}
    {state.status === 'ready' && !state.choices.length ? <ShellText>No workspaces are available. Open Talyn on the web to set up a workspace.</ShellText> : null}
    {state.choices.map((choice) => <View key={choice.id}><Button title={choice.name} accessibilityLabel={`Select workspace ${choice.name}`}
      disabled={offline} onPress={() => { void workspace.select(choice.id).then(() => {
        if (workspace.getSnapshot().selected === choice.id) router.replace(consumeIntent() ?? '/sessions');
      }); }} /></View>)}
    <Button title="Account settings" onPress={() => router.push('/settings')} />
    <Button title="Sign out" onPress={() => { void controller.signOut(); }} />
  </ShellScreen>;
}
