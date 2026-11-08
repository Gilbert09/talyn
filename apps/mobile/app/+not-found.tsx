import { ShellLink, ShellScreen } from '../src/components/ShellScreen';

export default function NotFoundScreen() {
  return (
    <ShellScreen title="Page unavailable" description="This page does not exist in the development app.">
      <ShellLink href="/sessions" label="Open Sessions" />
    </ShellScreen>
  );
}
