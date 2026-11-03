/**
 * Sandbox reads fail for a few seconds when the fleet host restarts. These
 * errors are transient: keep what is on screen, say we are reconnecting and
 * try again. Any other error is real and shows as before.
 */

const TRANSIENT_CODES = new Set(['fleet_unavailable', 'sandbox_waking']);

const TRANSIENT_MESSAGES = [
  'The sandbox runners are not reachable right now.',
  'The sandbox runners are all busy.',
];

/** Waits between tries: 2 s, 4 s, 8 s, 16 s. The last try ends about 30 s after the first. */
export const RECONNECT_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000];

export const RECONNECTING_TEXT = 'Reconnecting to the sandbox…';

export function isTransientSandboxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  return TRANSIENT_MESSAGES.some((m) => err.message.startsWith(m));
}

/**
 * Run `read`. On a transient error, call `onReconnecting(true)`, wait, and try
 * again. The last error throws once the delays run out. `isCancelled` stops the
 * loop (unmount, or the panel moved to another session) and ends it quietly.
 */
export async function readWithReconnect<T>(
  read: () => Promise<T>,
  opts: {
    onReconnecting?: (reconnecting: boolean) => void;
    isCancelled?: () => boolean;
    delays?: readonly number[];
  } = {}
): Promise<T> {
  const delays = opts.delays ?? RECONNECT_DELAYS_MS;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (err) {
        if (!isTransientSandboxError(err) || attempt >= delays.length || opts.isCancelled?.()) throw err;
        opts.onReconnecting?.(true);
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        if (opts.isCancelled?.()) throw err;
      }
    }
  } finally {
    opts.onReconnecting?.(false);
  }
}
