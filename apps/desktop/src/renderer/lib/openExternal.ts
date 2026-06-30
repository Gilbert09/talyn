/**
 * Open a URL in the system browser. Prefers the Electron preload bridge
 * (`shell.openExternal`) so links leave the app window, falling back to
 * `window.open` in non-Electron contexts. This is the single path every
 * "open in browser" affordance should route through.
 */
export async function openExternal(url: string): Promise<void> {
  if (window.electron?.auth?.openExternal) {
    await window.electron.auth.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * True when a mouse event should open a link in the browser rather than trigger
 * the element's default action: cmd/ctrl-click (modifier) or a middle/aux click.
 */
export function isOpenInBrowserClick(
  e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'button'>
): boolean {
  return e.metaKey || e.ctrlKey || e.button === 1;
}
