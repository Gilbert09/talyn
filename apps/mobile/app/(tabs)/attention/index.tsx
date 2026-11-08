import { ShellLink, ShellScreen } from '../../../src/components/ShellScreen';
import { pullRequestRoute } from '../../../src/navigation/routes';

export default function AttentionScreen() {
  return (
    <ShellScreen title="Attention" description="Example pull requests. Mobile review workflows will follow in a later release.">
      <ShellLink href={pullRequestRoute('example-pr')} label="Open example pull request" />
    </ShellScreen>
  );
}
