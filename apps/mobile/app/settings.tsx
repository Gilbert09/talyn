import { EdgeSwipeBack } from '../src/components/EdgeSwipeBack';
import { SettingsScreen } from '../src/features/settings/SettingsScreen';
import { ColdBack } from '../src/navigation/DetailRoute';
import { HOME } from '../src/navigation/routes';

// Settings needs no workspace, so a person with none can still sign out. It skips DetailRoute's workspace gate but keeps its swipe back.
export default function Screen() {
  return <EdgeSwipeBack><ColdBack list={HOME} /><SettingsScreen /></EdgeSwipeBack>;
}
