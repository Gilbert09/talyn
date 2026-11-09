import { ReturnStep } from '../../src/features/settings/ReturnStep';

/** The return link of the PostHog Code sign-in. It steps back at once. */
export default function Screen() {
  return <ReturnStep label="Checking PostHog" />;
}
