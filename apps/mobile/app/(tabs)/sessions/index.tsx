import { ShellLink, ShellScreen } from '../../../src/components/ShellScreen';
import { sessionRoute } from '../../../src/navigation/routes';

export default function SessionsScreen() {
  return (
    <ShellScreen title="Sessions" description="Example sessions. Mobile session workflows will follow in a later release.">
      <ShellLink href={sessionRoute('example-session')} label="Open example session" />
    </ShellScreen>
  );
}
