import { SettingsScreen } from '../src/features/settings/SettingsScreen';
import { ColdBack } from '../src/navigation/DetailRoute';
import { HOME } from '../src/navigation/routes';

// Settings needs no workspace, so a person with none can still sign out. It skips DetailRoute's workspace gate.
export default function Screen() {
  return <><ColdBack list={HOME} /><SettingsScreen /></>;
}
