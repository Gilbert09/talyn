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
