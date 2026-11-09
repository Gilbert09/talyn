import { Redirect, Stack, useLocalSearchParams, usePathname } from 'expo-router';

import { useWorkspace } from '../../src/auth/AuthProvider';
import { EdgeSwipeBack } from '../../src/components/EdgeSwipeBack';
import { pullsTab, PULLS_TITLES } from '../../src/features/prs/lists';
import { PullRequestsScreen } from '../../src/features/prs/PullRequestsScreen';
import { WorkspaceWait } from '../../src/navigation/DetailRoute';
import { rememberIntent } from '../../src/navigation/intents';
import { workspaceGate } from '../../src/navigation/workspaceGate';

/** `/pulls?tab=mine|reviews|queue`. A root destination, so it adds no back button of its own. */
export default function Screen() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const tab = pullsTab(params.tab);
  const workspace = useWorkspace();
  const pathname = usePathname();
  const gate = workspaceGate(workspace);
  if (gate === 'wait') return <WorkspaceWait />;
  if (gate === 'choose') {
    rememberIntent(pathname);
    return <Redirect href="/workspaces" />;
  }
  return <EdgeSwipeBack>
    <Stack.Screen options={{ headerShown: true, title: PULLS_TITLES[tab] }} />
    <PullRequestsScreen key={tab} tab={tab} />
  </EdgeSwipeBack>;
}
