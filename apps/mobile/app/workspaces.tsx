import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { Button, EmptyState, Group, Row } from '../src/components/UI';
import { consumeIntent } from '../src/navigation/intents';
import { HOME } from '../src/navigation/routes';
import { useAuth, useMobileRuntime, useNetwork, useWorkspace } from '../src/auth/AuthProvider';
import { Status } from '../src/components/AuthControls';
import { ShellScreen, useShellColors } from '../src/components/ShellScreen';

export default function WorkspacesScreen() {
  const state = useWorkspace();
  const { workspace, auth: controller, signOut } = useMobileRuntime();
  const user = useAuth().user;
  const offline = useNetwork() === 'offline';
  const router = useRouter();
  const colors = useShellColors();
  return <ShellScreen title="Choose a workspace" description="Keep your sessions and conversations in one place.">
    {(state.status === 'loading' || state.status === 'idle') && !state.choices.length ? <Status message="Loading workspaces" loading /> : null}
    {offline ? <Status message="You are offline. Connect to the internet to check workspace access." /> : null}
    {state.status === 'error' ? <><Status message="Workspaces could not load. Please try again." />
      <Button title="Try again" disabled={offline} onPress={() => { if (user) void workspace.load(user.id); }} /></> : null}
    {state.status === 'ready' && !state.choices.length ? <EmptyState title="No workspaces yet" detail="Open Talyn on the web to set up a workspace." /> : null}
    {state.choices.length ? <Group title="Your workspaces">
      {state.choices.map((choice, index) => <Row key={choice.id} title={choice.name} selected={state.selected === choice.id}
        divider={index < state.choices.length - 1}
        trailing={state.selected === choice.id ? <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={16} tintColor={colors.primaryAction} /> : undefined}
        accessibilityLabel={`Select workspace ${choice.name}`}
        disabled={offline} onPress={() => { void workspace.select(choice.id).then(() => {
          if (workspace.getSnapshot().selected === choice.id) router.replace(consumeIntent() ?? HOME);
        }); }} />)}
    </Group> : null}
    <Group title="Account">
      <Row title="Account settings" chevron onPress={() => router.push('/settings')} />
      <Row title="Sign out" divider={false} onPress={() => { void (signOut ? signOut() : controller.signOut()); }} />
    </Group>
  </ShellScreen>;
}
