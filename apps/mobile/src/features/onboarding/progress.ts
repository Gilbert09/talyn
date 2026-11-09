import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { useAuth, useWorkspace } from '../../auth/AuthProvider';

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Whether onboarding started on this device and was not finished. Like web's
 * `onboardingStartedOnThisDevice`: a device that showed the wizard resumes it,
 * and a returning account with GitHub connected never sees it. Reads are held
 * in memory so a step change never waits on storage.
 */
export class OnboardingProgress {
  private values = new Map<string, boolean>();
  private loading = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private storage: Storage) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }

  /** Undefined until the stored answer is read. */
  read(key: string): boolean | undefined { return this.values.get(key); }

  async load(key: string): Promise<void> {
    if (this.values.has(key) || this.loading.has(key)) return;
    this.loading.add(key);
    let value = false;
    try { value = (await this.storage.getItem(key)) === '1'; } catch { /* Storage failed: treat as not started. */ }
    this.loading.delete(key);
    if (!this.values.has(key)) { this.values.set(key, value); this.emit(); }
  }

  start(key: string) { this.set(key, true); }
  finish(key: string) { this.set(key, false); }

  private set(key: string, value: boolean) {
    if (this.values.get(key) === value) return;
    this.values.set(key, value);
    this.emit();
    void (value ? this.storage.setItem(key, '1') : this.storage.removeItem(key)).catch(() => {});
  }
}

// Loaded on first use: the native module is absent where no screen needs it, such as most tests.
const deviceStorage: Storage = {
  getItem: async (key) => storageModule().getItem(key),
  setItem: async (key, value) => storageModule().setItem(key, value),
  removeItem: async (key) => storageModule().removeItem(key),
};
function storageModule(): Storage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@react-native-async-storage/async-storage') as { default: Storage }).default;
}

export const onboardingProgress = new OnboardingProgress(deviceStorage);

export const progressKey = (user: string, workspace: string) =>
  `talyn.onboarding.${encodeURIComponent(user)}.${encodeURIComponent(workspace)}`;

/** The selected workspace's onboarding progress on this device. */
export function useOnboardingProgress() {
  const user = useAuth().user?.id ?? null;
  const workspace = useWorkspace().selected;
  const key = user && workspace ? progressKey(user, workspace) : null;
  const inProgress = useSyncExternalStore(onboardingProgress.subscribe, () => key ? onboardingProgress.read(key) : undefined);
  useEffect(() => { if (key) void onboardingProgress.load(key); }, [key]);
  const start = useCallback(() => { if (key) onboardingProgress.start(key); }, [key]);
  const finish = useCallback(() => { if (key) onboardingProgress.finish(key); }, [key]);
  return { inProgress, start, finish };
}
