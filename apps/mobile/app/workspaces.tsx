import { useRouter } from 'expo-router';

import { Badge, Button, Divider, EmptyState, ListRow, SectionHeader } from '../src/components/UI';
import { consumeIntent } from '../src/navigation/intents';
import { useAuth, useMobileRuntime, useNetwork, useWorkspace } from '../src/auth/AuthProvider';
import { Status } from '../src/components/AuthControls';
import { ShellScreen } from '../src/components/ShellScreen';

export default function WorkspacesScreen() {
  const state = useWorkspace();
  const { workspace, auth: controller, signOut } = useMobileRuntime();
  const user = useAuth().user;
  const offline = useNetwork() === 'offline';
  const router = useRouter();
  return <ShellScreen title="Choose a workspace" description="Keep your sessions and conversations in one place.">
    {state.status === 'loading' || state.status === 'idle' ? <Status message="Loading workspaces" loading /> : null}
    {offline ? <Status message="You are offline. Connect to the internet to check workspace access." /> : null}
    {state.status === 'error' ? <><Status message="Workspaces could not load. Please try again." />
      <Button title="Try again" disabled={offline} onPress={() => { if (user) void workspace.load(user.id); }} /></> : null}
    {state.status === 'ready' && !state.choices.length ? <EmptyState title="No workspaces yet" detail="Open Talyn on the web to set up a workspace." /> : null}
    <SectionHeader title="Your workspaces" />
    {state.choices.map((choice) => <ListRow key={choice.id} title={choice.name} selected={state.selected === choice.id}
      subtitle={state.selected === choice.id ? 'Current workspace' : 'Switch to this workspace'}
      trailing={state.selected === choice.id ? <Badge label="Selected" tone="primary" /> : undefined} accessibilityLabel={`Select workspace ${choice.name}`}
      disabled={offline} onPress={() => { void workspace.select(choice.id).then(() => {
        if (workspace.getSnapshot().selected === choice.id) router.replace(consumeIntent() ?? '/sessions');
      }); }} />)}
    <Divider /><SectionHeader title="Account" />
    <Button variant="secondary" title="Account settings" onPress={() => router.push('/settings')} />
    <Button variant="quiet" title="Sign out" onPress={() => { void (signOut ? signOut() : controller.signOut()); }} />
  </ShellScreen>;
}
