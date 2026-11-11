/**
 * Electron wraps an error thrown in the main process as
 * `Error invoking remote method 'x': Error: message`. A person needs only the message.
 */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  const stripped = error.message
    .replace(/^Error invoking (?:remote )?method ['"][^'"]*['"]:\s*/, '')
    .replace(/^(?:[A-Za-z]*Error):\s*/, '')
    .trim();
  return stripped || fallback;
}
