import { ShellLink, ShellScreen } from '../src/components/ShellScreen';

export default function NotFoundScreen() {
  return (
    <ShellScreen topInset centered title="Page unavailable" description="This link does not lead to a Talyn page.">
      <ShellLink href="/sessions" label="Open Sessions" />
    </ShellScreen>
  );
}
