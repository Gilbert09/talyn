import { ShellLink, ShellScreen } from '../../../src/components/ShellScreen';
import { pullRequestRoute } from '../../../src/navigation/routes';

export default function AttentionScreen() {
  return (
    <ShellScreen title="Attention" description="See pull requests that need your attention.">
      <ShellLink href={pullRequestRoute('example-pr')} label="Open example pull request" />
    </ShellScreen>
  );
}
