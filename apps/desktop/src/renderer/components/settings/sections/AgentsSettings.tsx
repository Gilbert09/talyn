import { getWorkbenchBridge } from '../../../lib/workbenchBridge';
import { LocalAgentStatus } from '../../onboarding/steps/LocalAgentStatus';
import { SettingsPage } from '../../ui/settings';
import { SettingsGroup } from '../SettingsGroup';
import { ProviderConnectCards } from '../providerCards';

export function AgentsSettings() {
  return (
    <SettingsPage title="Agents" description="Where your agents run: in Talyn's cloud, or on this computer.">
      <SettingsGroup
        title="Cloud providers"
        description="Vendors that run your tasks and open PRs. Connect one or more."
      >
        <ProviderConnectCards />
      </SettingsGroup>
      {getWorkbenchBridge() && (
        <SettingsGroup title="On this computer">
          <LocalAgentStatus recheck />
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
