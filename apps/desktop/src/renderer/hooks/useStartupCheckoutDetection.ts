import { useEffect } from 'react';
import { autoDetectCheckouts } from '../lib/checkoutDetection';
import { useWorkspaceStore } from '../stores/workspace';

// Wait for the first screen to settle before the scan reads the disk.
const START_DELAY_MS = 3000;
const scanned = new Set<string>();

/**
 * Once per launch, finds local checkouts for watched repos that have none.
 * It reads only the local disk: never a network share or an external volume,
 * and never a folder that macOS asks permission for.
 */
export function useStartupCheckoutDetection(): void {
  const names = useWorkspaceStore((s) => s.repositories.map((repo) => repo.fullName).sort().join('\n'));
  useEffect(() => {
    if (!names) return undefined;
    const wanted = names.split('\n').filter((name) => !scanned.has(name.toLowerCase()));
    if (wanted.length === 0) return undefined;
    const timer = setTimeout(() => {
      for (const name of wanted) scanned.add(name.toLowerCase());
      void autoDetectCheckouts(wanted, { startup: true }).catch(() => undefined);
    }, START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [names]);
}
