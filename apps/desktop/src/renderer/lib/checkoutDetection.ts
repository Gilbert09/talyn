import { localPathFor } from '../pages/NewWorkbenchPage';
import { getWorkbenchBridge } from './workbenchBridge';

export interface CheckoutDetection {
  /** The saved map after the scan, or null when nothing was saved. */
  map: Record<string, string> | null;
  /** Lower-case repo name → the checkout that was saved for it. */
  found: Record<string, string>;
  /** Lower-case repo name → the checkouts to choose from, when more than one main checkout matched. */
  choices: Record<string, string[]>;
}

/**
 * Finds a checkout for each watched repo that has no local path, and saves a
 * path only when exactly one main checkout matches. A saved path is never
 * replaced (`ifMissing`), so a choice the user made wins over a later scan.
 */
export async function autoDetectCheckouts(
  repoFullNames: string[],
  opts: { startup?: boolean } = {},
): Promise<CheckoutDetection> {
  const result: CheckoutDetection = { map: null, found: {}, choices: {} };
  const bridge = getWorkbenchBridge();
  if (!bridge?.repoPaths?.detect) return result;
  const saved = await bridge.repoPaths.get();
  const missing = repoFullNames.filter((name) => name && !localPathFor(saved, name));
  if (missing.length === 0) return result;
  const detected = await bridge.repoPaths.detect({ repoFullNames: missing, startup: opts.startup });
  const multiple = Object.fromEntries(Object.entries(detected).filter(([, values]) => values.length > 1));
  const main: Record<string, string> = Object.keys(multiple).length && bridge.repoPaths.uniqueMain
    ? await bridge.repoPaths.uniqueMain(multiple).catch(() => ({}))
    : {};
  for (const name of missing) {
    const options = detected[name] ?? [];
    const automatic = options.length === 1 ? options[0] : main[name];
    if (automatic) {
      result.map = await bridge.repoPaths.set({ repoFullName: name, path: automatic, ifMissing: true });
      if (localPathFor(result.map, name) === automatic) result.found[name.toLowerCase()] = automatic;
    } else if (options.length > 1) {
      result.choices[name.toLowerCase()] = options;
    }
  }
  return result;
}
