import { ShellLink, ShellScreen } from '../src/components/ShellScreen';
import { HOME } from '../src/navigation/routes';

export default function NotFoundScreen() {
  return (
    <ShellScreen topInset centered title="Page unavailable" description="This link does not lead to a Talyn page.">
      <ShellLink href={HOME} label="Go home" />
    </ShellScreen>
  );
}
