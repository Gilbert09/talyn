import { useEffect, useState } from 'react';

/**
 * Whether this is a local dev build (vs a packaged/production app). Read once
 * from the main process over IPC. Used to flag the UI — e.g. the amber "DEV"
 * badge on the sidebar profile — so a dev build is unmistakable. Defaults to
 * false until the IPC resolves, so production never flashes the badge.
 */
export function useIsDevBuild(): boolean {
  const [isDev, setIsDev] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.electron?.app
      ?.isDev()
      .then((v) => {
        if (!cancelled) setIsDev(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return isDev;
}
