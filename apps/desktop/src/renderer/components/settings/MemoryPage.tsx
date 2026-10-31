import { workbenchesOffered } from '@talyn/shared';
import { useWorkspaceStore } from '../../stores/workspace';
import { SettingsPage } from '../ui/settings';
import { MemorySection } from './MemorySection';

export function MemoryPage() {
  const features = useWorkspaceStore((s) => s.features);
  if (!workbenchesOffered(features)) return null;
  return (
    <SettingsPage
      title="Memory"
      description="Notes that sessions save as they learn, and notes you add. Every session, task and review reads them."
    >
      <MemorySection />
    </SettingsPage>
  );
}
