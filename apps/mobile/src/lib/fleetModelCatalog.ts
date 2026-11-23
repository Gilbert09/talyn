import { models } from '@talyn/client/native';
import {
  getFleetModelCatalog,
  setFleetModelCatalog,
  subscribeFleetModelCatalog,
  type FleetModelCatalog,
} from '@talyn/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

/**
 * The agent model catalogue comes from the backend (`GET /models`), so a new
 * model needs no store release. Until the first answer, the bundled list
 * applies. A failed fetch keeps the current catalogue: an older backend has no
 * `/models`, and a network error must not empty the pickers.
 */
export async function refreshFleetModelCatalog(fetchCatalog?: () => Promise<unknown>): Promise<void> {
  try {
    setFleetModelCatalog(await (fetchCatalog ?? models.get)());
  } catch {
    // Keep the current catalogue.
  }
}

/** Fetch the catalogue once signed in, and again each time the app returns to the foreground. */
export function useFleetModelCatalogSync(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    void refreshFleetModelCatalog();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshFleetModelCatalog();
    });
    return () => subscription.remove();
  }, [enabled]);
}

/** The live catalogue. A screen that lists models calls this, so it renders again when the catalogue arrives. */
export function useFleetModelCatalog(): FleetModelCatalog {
  return useSyncExternalStore(subscribeFleetModelCatalog, getFleetModelCatalog);
}
