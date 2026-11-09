import * as Updates from 'expo-updates';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { createUpdateController, type UpdateController } from './controller';
import type { UpdateState } from './model';

let shared: UpdateController | null = null;

function updatesEnabled(): boolean {
  // The development client loads from Metro, and a binary built with updates off reports false.
  try { return !__DEV__ && Updates.isEnabled; } catch { return false; }
}

/** One controller for the app, so the banner and About show the same check. */
export function appUpdates(): UpdateController {
  shared ??= createUpdateController({
    checkForUpdateAsync: () => Updates.checkForUpdateAsync(),
    fetchUpdateAsync: () => Updates.fetchUpdateAsync(),
    reloadAsync: () => Updates.reloadAsync(),
  }, { enabled: updatesEnabled() });
  return shared;
}

export function useAppUpdates(controller: UpdateController = appUpdates()): UpdateState & Pick<UpdateController, 'check' | 'restart' | 'dismiss'> {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return { ...state, check: controller.check, restart: controller.restart, dismiss: controller.dismiss };
}

/** Checks once at cold start and again each time the app returns to the foreground, at most every 15 minutes. */
export function useUpdateChecks(controller: UpdateController = appUpdates()) {
  useEffect(() => {
    void controller.check('launch');
    const subscription = AppState.addEventListener('change', (next) => { if (next === 'active') void controller.check('foreground'); });
    return () => subscription.remove();
  }, [controller]);
}
