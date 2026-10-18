import { useEffect } from 'react';
import { workbenchesOffered } from '@talyn/shared';
import { syncChangedInstructionFiles } from '../lib/instructionFiles';
import { getWorkbenchBridge } from '../lib/workbenchBridge';
import { toast } from '../stores/toast';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * At start, and when the workspace changes: upload each switched-on
 * instruction file that changed on this Mac since it was last uploaded.
 * Silent unless an upload fails.
 */
export function useInstructionFileSync(): void {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const features = useWorkspaceStore((s) => s.features);
  const offered = features === null ? null : workbenchesOffered(features);

  useEffect(() => {
    const bridge = getWorkbenchBridge();
    if (!workspaceId || !offered || !bridge?.instructionFiles) return;
    syncChangedInstructionFiles(workspaceId, bridge)
      .then(({ failed }) => {
        if (failed > 0) toast.error('Could not upload your changed instruction files', 'Open Settings → Sessions to try again.');
      })
      .catch((err) => console.warn('[instructions] sync at start failed:', err));
  }, [workspaceId, offered]);
}
