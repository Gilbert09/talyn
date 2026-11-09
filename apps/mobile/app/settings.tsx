import { SettingsScreen } from '../src/features/settings/SettingsScreen';
import { ColdBack } from '../src/navigation/DetailRoute';
import { HOME } from '../src/navigation/routes';

// Settings needs no workspace, so a person with none can still sign out.
export default function Screen() {
  return <><ColdBack list={HOME} /><SettingsScreen /></>;
}
