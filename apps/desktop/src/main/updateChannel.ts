/**
 * Update-channel preference, persisted in userData so the MAIN process can
 * apply it at boot — the background update checks start before the renderer
 * has a chance to send anything, so this can't live in renderer storage.
 */
import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UpdateChannel } from './updaterEvents';

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'update-channel.json');
}

/** The persisted channel; `stable` on first run or an unreadable file. */
export function getUpdateChannel(): UpdateChannel {
  try {
    const raw = JSON.parse(readFileSync(prefsPath(), 'utf8')) as {
      channel?: string;
    };
    if (raw.channel === 'nightly') return 'nightly';
  } catch {
    /* first run / unreadable → default */
  }
  return 'stable';
}

export function setUpdateChannel(channel: UpdateChannel): void {
  mkdirSync(path.dirname(prefsPath()), { recursive: true });
  writeFileSync(prefsPath(), JSON.stringify({ channel }), 'utf8');
}
