/**
 * Shared shape of the auto-update events the main process forwards to the
 * renderer over the `updater:event` IPC channel. Type-only — imported by
 * both `updater.ts` (emitter) and `preload.ts` (bridge typing), so the
 * renderer gets it for free via the derived `ElectronHandler` type.
 */
export type UpdaterEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

/** Result of an explicit `updater:check` invocation. */
export type UpdaterCheckResult =
  | { started: true }
  | { started: false; reason: 'not-packaged' };

/**
 * Which release feed the updater follows. `stable` (the default) only sees
 * full GitHub releases — the tagged builds; `nightly` also sees pre-releases
 * (the nightly channel).
 */
export type UpdateChannel = 'stable' | 'nightly';
