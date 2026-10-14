import { SettingsShell } from '../settings/SettingsShell';

/**
 * The Settings view. The page lives in `components/settings/`; this file keeps
 * the old import path working for the shell and for the cards other surfaces
 * (the connect-agent modal, onboarding, tests) import from here.
 */
export function SettingsPanel() {
  return <SettingsShell />;
}

export {
  ProviderConnectCards,
  FleetAgentRow,
  PostHogCodeCard,
  cloudProviderOffered,
} from '../settings/providerCards';
export {
  AutoKeepMergeableDefaultToggle,
  AutoKeepMergeableLabelsField,
  CloudProviderDefaultSelector,
  RespondToHumanCommentsToggle,
} from '../settings/sections/PullRequestsSettings';
export { WorkspaceModelSelector } from '../settings/WorkspaceModelSelector';
