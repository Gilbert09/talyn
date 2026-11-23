/** IPC channels for desk presence. Kept free of Electron imports so the preload can load it. */
export const DESK_PRESENCE_CHANNEL = 'desk-presence:get';
export const DESK_PRESENCE_CHANGED_CHANNEL = 'desk-presence:changed';
export type DeskState = 'active' | 'away';
