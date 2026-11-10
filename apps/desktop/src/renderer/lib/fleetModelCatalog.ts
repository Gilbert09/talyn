import { useSyncExternalStore } from 'react';
import {
  getFleetModelCatalog,
  setFleetModelCatalog,
  subscribeFleetModelCatalog,
  type FleetModelCatalog,
} from '@talyn/shared';
import { api } from './api';

/**
 * The agent model catalogue comes from the backend (`GET /models`), so a new
 * model needs no app release. This file keeps the live copy in `@talyn/shared`
 * up to date. The last answer is kept in localStorage, so the next launch shows
 * it before the network answers. With no answer yet, the bundled list applies.
 */
const STORAGE_KEY = 'talyn.fleetModelCatalog';

/** Apply the stored catalogue. Call once, before the first render. */
export function hydrateFleetModelCatalog(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) setFleetModelCatalog(JSON.parse(raw));
  } catch {
    // Unreadable storage or a corrupt entry: the bundled catalogue stays.
  }
}

/**
 * Fetch the catalogue and apply it. A failed fetch keeps the current
 * catalogue: an older backend has no `/models`, and a network error must not
 * empty the pickers.
 */
export async function refreshFleetModelCatalog(): Promise<void> {
  let catalog: unknown;
  try {
    catalog = await api.models.get();
  } catch {
    return;
  }
  if (!setFleetModelCatalog(catalog)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(getFleetModelCatalog()));
  } catch {
    // Storage can be full or unavailable. The catalogue still applies now.
  }
}

/**
 * The live catalogue. A component that lists models must call this, so that
 * it renders again when the backend's catalogue arrives.
 */
export function useFleetModelCatalog(): FleetModelCatalog {
  return useSyncExternalStore(subscribeFleetModelCatalog, getFleetModelCatalog);
}
