import { ShellLink, ShellScreen } from '../../../src/components/ShellScreen';
import { sessionRoute } from '../../../src/navigation/routes';

export default function SessionsScreen() {
  return (
    <ShellScreen title="Sessions" description="See work on your repositories.">
      <ShellLink href={sessionRoute('example-session')} label="Open example session" />
    </ShellScreen>
  );
}
