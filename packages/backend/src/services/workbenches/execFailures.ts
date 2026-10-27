/**
 * How a failed exec reads: a full disk, or a guest the fleet could not reach
 * before the command started. Plus the disk-space probe. Pure, so the exec
 * layer can use it without an import cycle.
 */

// ============================================================================
// The guest was not reached
// ============================================================================

/**
 * Errors that PROVE the command never started: fleetd could not open its vsock
 * connection to the guest agent (the box was suspending or resuming, or the
 * agent restarted). The CONNECT handshake comes before the exec request, so a
 * failure in it, or in the dial, means the guest saw nothing. A reset after
 * output began matches none of these.
 */
const GUEST_NOT_STARTED_PATTERNS = [
  /read CONNECT reply/,
  /\bdial (?:unix|vsock)\b[^\n]*(?:vsock|guest)/i,
  /Post "http:\/\/guest\/[^"]*": dial\b/,
];

export function isGuestUnreachableBeforeStart(err: unknown): boolean {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return GUEST_NOT_STARTED_PATTERNS.some((p) => p.test(text));
}

/** The waits before each retry of an exec the guest never started. */
export const GUEST_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 6_000];

// ============================================================================
// Disk space
// ============================================================================

const GIB = 1024 * 1024 * 1024;

/** Below this much free space a turn does not start on the box as it is. */
export const LOW_DISK_BYTES = 2 * GIB;

/** What a grow aims for: enough room for a few installs and builds. */
export const GROW_TARGET_FREE_BYTES = 8 * GIB;

/**
 * The words a full disk produces: the errno name, the libc message, and the
 * fleet's own refusal. Matched exactly, so an unrelated failure never moves a
 * session.
 */
const DISK_FULL_PATTERN = /ENOSPC|No space left on device|Out of diskspace/;

export function isDiskFullText(text: string | null | undefined): boolean {
  return typeof text === 'string' && DISK_FULL_PATTERN.test(text);
}

/** An error, or anything in its cause chain, that says the disk is full. */
export function isDiskFullError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      if (isDiskFullText(current.message)) return true;
      if ((current as { code?: unknown }).code === 'ENOSPC') return true;
      current = (current as { cause?: unknown }).cause;
    } else {
      return isDiskFullText(String(current));
    }
  }
  return false;
}

export interface DiskProbe {
  availBytes: number;
  sizeBytes: number;
}

/** The marker the probe line starts with. Printed to stderr, so it never mixes with a script's stdout. */
export const DISK_PROBE_TAG = 'TALYN_DISK';

/**
 * One line that reports the root filesystem's free and total bytes. `df`
 * writes nothing, so it runs on a full disk too. Never fails the script.
 */
export const DISK_PROBE_SCRIPT = `{ df -B1 --output=avail,size / 2>/dev/null | tail -n 1 | sed 's/^ */${DISK_PROBE_TAG} /' >&2; } || true`;

/** The probe's numbers from a script's stderr, or null when it printed none. */
export function parseDiskProbe(stderr: string): DiskProbe | null {
  const match = new RegExp(`^${DISK_PROBE_TAG} (\\d+)\\s+(\\d+)\\s*$`, 'm').exec(stderr);
  if (!match) return null;
  return { availBytes: Number(match[1]), sizeBytes: Number(match[2]) };
}

/** Stderr without the probe line, for an error message. */
export function withoutDiskProbe(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !line.startsWith(`${DISK_PROBE_TAG} `))
    .join('\n');
}

/**
 * The rootfs size, in MiB, that leaves `GROW_TARGET_FREE_BYTES` free. Null
 * when the box already has that much.
 */
export function grownDiskMib(probe: DiskProbe, currentDiskMib?: number | null): number | null {
  const need = GROW_TARGET_FREE_BYTES - probe.availBytes;
  if (need <= 0) return null;
  // A repo golden can be larger than the record's diskMib, so the measured size wins when bigger.
  const current = Math.max(currentDiskMib && currentDiskMib > 0 ? currentDiskMib : 0, Math.ceil(probe.sizeBytes / (1024 * 1024)));
  return current + Math.ceil(need / (1024 * 1024));
}
