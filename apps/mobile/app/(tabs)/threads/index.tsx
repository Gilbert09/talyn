import { ShellLink, ShellScreen } from '../../../src/components/ShellScreen';
import { threadRoute } from '../../../src/navigation/routes';

export default function ThreadsScreen() {
  return (
    <ShellScreen title="Threads" description="Example threads. Mobile thread workflows will follow in a later release.">
      <ShellLink href={threadRoute('example-thread')} label="Open example thread" />
    </ShellScreen>
  );
}
