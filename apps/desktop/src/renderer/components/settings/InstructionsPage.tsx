import { workbenchesOffered } from '@talyn/shared';
import { useWorkspaceStore } from '../../stores/workspace';
import { InstructionsSettings } from '../panels/InstructionsSettings';
import { SettingsPage } from '../ui/settings';
import { InstructionFilesSection } from './InstructionFilesSection';
import { RepositoryInstructionsSection } from './RepositoryInstructionsSection';

/**
 * Everything that tells an agent how to work: the user's own files from this
 * Mac, instructions written per repository, then the prompts Talyn hands to a
 * cloud agent. The first two reach sessions, so they follow the sessions flag.
 */
export function InstructionsPage() {
  const features = useWorkspaceStore((s) => s.features);
  const sessions = workbenchesOffered(features);
  return (
    <SettingsPage title="Instructions">
      {sessions ? <InstructionFilesSection /> : null}
      {sessions ? <RepositoryInstructionsSection /> : null}
      <InstructionsSettings />
    </SettingsPage>
  );
}
