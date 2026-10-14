import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { UpdaterEvent } from '../../../main/updaterEvents';

/**
 * Auto-update notice, shown at the very top of the sidebar footer (above the
 * cloud-provider status and the user chip). Stays invisible until the main
 * process reports a download in progress or a downloaded update ready to
 * apply. Clicking the "ready" state quits and relaunches into the new version.
 */
export function UpdateNotice({ collapsed }: { collapsed: boolean }) {
  const [state, setState] = useState<UpdaterEvent | null>(null);

  useEffect(() => {
    return window.electron?.updater?.onEvent(setState);
  }, []);

  if (!state) return null;

  if (state.kind === 'progress') {
    return collapsed ? (
      <div
        title={`Downloading update… ${state.percent}%`}
        className="mb-2 flex h-6 items-center justify-center border-b pb-2"
      >
        <Download className="h-4 w-4 animate-pulse text-muted-foreground" />
      </div>
    ) : (
      <div className="mb-2 flex items-center gap-2 border-b px-2 pb-2 text-xs text-muted-foreground">
        <Download className="h-3.5 w-3.5 shrink-0 animate-pulse" />
        <span className="min-w-0 flex-1 truncate">
          Downloading update… {state.percent}%
        </span>
      </div>
    );
  }

  if (state.kind === 'downloaded') {
    const apply = () => window.electron?.updater?.quitAndInstall();
    return collapsed ? (
      <button
        type="button"
        onClick={apply}
        title={`Update ${state.version} ready — restart now, or Talyn installs it once you've been away for a while`}
        className="mb-2 flex h-6 w-full items-center justify-center border-b pb-2 text-green-600 hover:text-green-500"
      >
        <Download className="h-4 w-4" />
      </button>
    ) : (
      <button
        type="button"
        onClick={apply}
        title={`Restart now to install version ${state.version}. Otherwise Talyn installs it by itself once you've been away from your machine for a while.`}
        className="mb-2 flex w-full items-center gap-2 rounded-md border-b px-2 pb-2 text-xs text-green-600 hover:text-green-500"
      >
        <Download className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          Update ready — Restart
        </span>
      </button>
    );
  }

  // checking / not-available / error: nothing to surface in the sidebar.
  return null;
}
