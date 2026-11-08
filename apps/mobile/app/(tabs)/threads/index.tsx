import { ShellLink, ShellScreen } from '../../../src/components/ShellScreen';
import { threadRoute } from '../../../src/navigation/routes';

export default function ThreadsScreen() {
  return (
    <ShellScreen title="Threads" description="Plan work across your repositories.">
      <ShellLink href={threadRoute('example-thread')} label="Open example thread" />
    </ShellScreen>
  );
}
