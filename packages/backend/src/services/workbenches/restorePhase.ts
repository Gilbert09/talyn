import type { FleetSandbox } from '../selfHosted/client.js';

/** A box that answers its first exec this fast was awake already: no read, no phase. */
export const RESTORE_PROBE_DELAY_MS = 2_500;

const restoring = new Set<string>();

/**
 * A box that is not live yet. The fleet keeps `suspended` only until a request
 * claims the box; during the resume itself, bucket download included, it
 * reports `starting` (phase `placing`, then `restoring` or `resuming`).
 */
const WAKING: ReadonlySet<string> = new Set(['suspended', 'starting']);

/** Whether the chat's turn is waiting for its sandbox to come back from sleep. */
export function isRestoring(chatId: string): boolean {
  return restoring.has(chatId);
}

/**
 * Run the exec that wakes the box. When it is still pending after the probe
 * delay, read the box record once; if the box is not live yet, mark the chat as
 * restoring until the exec settles. A running box never reaches the read.
 */
export async function withRestorePhase<T>(
  chatId: string,
  work: () => Promise<T>,
  deps: {
    readSandbox: () => Promise<Pick<FleetSandbox, 'status'> | null>;
    publish: () => void | Promise<void>;
    delayMs?: number;
  },
): Promise<T> {
  let settled = false;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const sandbox = await deps.readSandbox();
        if (settled || !sandbox || !WAKING.has(sandbox.status)) return;
        restoring.add(chatId);
        await deps.publish();
      } catch {
        // The phase is a courtesy; a failed read leaves the plain working state.
      }
    })();
  }, deps.delayMs ?? RESTORE_PROBE_DELAY_MS);
  try {
    return await work();
  } finally {
    settled = true;
    clearTimeout(timer);
    if (restoring.delete(chatId)) await Promise.resolve(deps.publish()).catch(() => undefined);
  }
}
