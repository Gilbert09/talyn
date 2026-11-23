import { ScrollView } from 'react-native';

import { useWorkspace } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { workflowStyles as styles } from '../../components/Workflow';
import { ConnectGitHubStep } from '../onboarding/ConnectGitHubStep';
import { useGithubConnection } from '../onboarding/githubFlow';

/** Settings > GitHub: the connection, the Talyn App's installations and coverage, as onboarding shows them. */
export function GitHubSettingsScreen() {
  const workspace = useWorkspace().selected as string;
  const connection = useGithubConnection(workspace);
  return <ScreenContainer>
    <ScrollView contentContainerStyle={styles.content}>
      <ConnectGitHubStep workspaceId={workspace} connection={connection} source="settings" />
    </ScrollView>
  </ScreenContainer>;
}
