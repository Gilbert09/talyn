// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { UpdaterEvent, UpdaterCheckResult } from './updaterEvents';

export type Channels = 'ipc-example';

const electronHandler = {
  /** OS platform, for platform-specific window chrome (macOS traffic lights). */
  platform: process.platform,
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
  },
  auth: {
    /** Open an OAuth URL in the user's default browser. */
    openExternal(url: string): Promise<void> {
      return ipcRenderer.invoke('auth:open-external', url);
    },
    /**
     * The deep-link redirect URL to pass to Supabase's OAuth flow. Scheme is
     * `fastowl://` in prod and `fastowl-dev://` in dev, so the callback always
     * reopens this build rather than a separately-installed one.
     */
    getRedirectUrl(): Promise<string> {
      return ipcRenderer.invoke('auth:get-redirect-url');
    },
    /**
     * Subscribe to `fastowl://auth-callback` deep links. Also flushes any
     * callback that arrived before the renderer subscribed (common on
     * macOS when the app launches from a click in the browser).
     */
    onCallback(cb: (url: string) => void): () => void {
      const handler = (_e: IpcRendererEvent, url: string) => cb(url);
      ipcRenderer.on('auth:callback', handler);
      // Drain any queued callback from before we subscribed.
      ipcRenderer.invoke('auth:drain-pending').then((url?: string | null) => {
        if (url) cb(url);
      });
      return () => ipcRenderer.removeListener('auth:callback', handler);
    },
    /**
     * safeStorage-backed key/value store used as Supabase's session
     * storage. All three methods cross into the main process; the
     * ciphertext never rides through the renderer's localStorage.
     */
    storage: {
      getItem(key: string): Promise<string | null> {
        return ipcRenderer.invoke('auth:storage:get', key);
      },
      setItem(key: string, value: string): Promise<void> {
        return ipcRenderer.invoke('auth:storage:set', key, value);
      },
      removeItem(key: string): Promise<void> {
        return ipcRenderer.invoke('auth:storage:remove', key);
      },
    },
  },
  updater: {
    /**
     * Subscribe to auto-update lifecycle events forwarded by the main
     * process. Returns an unsubscribe fn.
     */
    onEvent(cb: (event: UpdaterEvent) => void): () => void {
      const handler = (_e: IpcRendererEvent, event: UpdaterEvent) => cb(event);
      ipcRenderer.on('updater:event', handler);
      return () => ipcRenderer.removeListener('updater:event', handler);
    },
    /** Trigger a manual check for updates (no-op in dev / unpackaged). */
    check(): Promise<UpdaterCheckResult> {
      return ipcRenderer.invoke('updater:check');
    },
    /** Quit and apply a downloaded update. */
    quitAndInstall(): Promise<void> {
      return ipcRenderer.invoke('updater:quit-and-install');
    },
  },
  app: {
    /** Current app version, e.g. for Settings → About. */
    getVersion(): Promise<string> {
      return ipcRenderer.invoke('app:get-version');
    },
    /** True for a local dev build — the renderer flags the UI with a DEV badge. */
    isDev(): Promise<boolean> {
      return ipcRenderer.invoke('app:is-dev');
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
