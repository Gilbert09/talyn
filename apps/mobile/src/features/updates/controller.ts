import { errorMessage, initialUpdateState, reduceUpdate, shouldCheck, type UpdateEvent, type UpdateState, type UpdateTrigger } from './model';

/** The part of `expo-updates` the app uses. Tests pass a fake. */
export interface UpdatesApi {
  checkForUpdateAsync(): Promise<{ isAvailable: boolean; isRollBackToEmbedded?: boolean }>;
  fetchUpdateAsync(): Promise<{ isNew: boolean; isRollBackToEmbedded?: boolean; manifest?: unknown }>;
  reloadAsync(): Promise<void>;
}

export interface UpdateController {
  getState(): UpdateState;
  subscribe(listener: () => void): () => void;
  /** Checks, then downloads in the background. It never reloads: the person chooses when to restart. */
  check(trigger: UpdateTrigger): Promise<void>;
  restart(): Promise<void>;
  dismiss(): void;
}

function manifestId(manifest: unknown): string | null {
  return manifest && typeof manifest === 'object' && 'id' in manifest && typeof manifest.id === 'string' ? manifest.id : null;
}

export function createUpdateController(api: UpdatesApi, { enabled, now = Date.now }: { enabled: boolean; now?: () => number }): UpdateController {
  let state = initialUpdateState(enabled);
  const listeners = new Set<() => void>();
  const dispatch = (event: UpdateEvent) => {
    const next = reduceUpdate(state, event);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async check(trigger) {
      const at = now();
      if (!shouldCheck(state, trigger, at)) return;
      dispatch({ type: 'check', at });
      try {
        const found = await api.checkForUpdateAsync();
        if (!found.isAvailable && !found.isRollBackToEmbedded) { dispatch({ type: 'current' }); return; }
        dispatch({ type: 'download' });
        const fetched = await api.fetchUpdateAsync();
        if (fetched.isRollBackToEmbedded) dispatch({ type: 'downloaded', updateId: null });
        else if (fetched.isNew) dispatch({ type: 'downloaded', updateId: manifestId(fetched.manifest) });
        else dispatch({ type: 'current' });
      } catch (error) {
        dispatch({ type: 'failed', message: errorMessage(error) });
      }
    },
    async restart() {
      try { await api.reloadAsync(); } catch (error) { dispatch({ type: 'failed', message: errorMessage(error) }); }
    },
    dismiss: () => dispatch({ type: 'dismiss' }),
  };
}
