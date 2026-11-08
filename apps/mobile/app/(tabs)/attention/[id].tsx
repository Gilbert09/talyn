import { useLocalSearchParams } from 'expo-router';

import { ShellScreen, ShellText } from '../../../src/components/ShellScreen';
import { examplePullRequestState } from '../../../src/domain/examples';

export default function PullRequestScreen() {
  const { id } = useLocalSearchParams<'/attention/[id]'>();
  return (
    <ShellScreen title="Example pull request" description="Checks and review status will appear here.">
      <ShellText>Pull request: {id}</ShellText>
      <ShellText>Example status: {examplePullRequestState}</ShellText>
    </ShellScreen>
  );
}
