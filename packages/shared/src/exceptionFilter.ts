/**
 * Which captured exceptions are worth keeping.
 *
 * Both front ends autocapture unhandled errors, unhandled rejections and
 * `console.error`. That is the right default — but a desktop app whose whole
 * job is talking to a hosted backend generates a large, permanent class of
 * "exceptions" that are the expected outcome rather than a defect. Measured
 * over 30 days, nine in every ten captured events were one of the cases below,
 * which buried the handful that were real bugs.
 *
 * This is a DROP list, so the bar is high: a rule belongs here only when the
 * event can never be acted on in code, whatever its volume. Anything merely
 * noisy, frequent, or annoying stays — it gets tagged and grouped instead.
 *
 * Shared rather than forked into each app on purpose. The two clients may
 * diverge freely in UI, but a filter that decides what we are able to SEE must
 * not: one copy quietly growing a rule the other lacks would show up as a
 * behaviour difference between clients that nobody could explain from the data.
 */

/** What the filter needs to know about one captured exception. */
export interface CapturedException {
  /** The `$exception_list` values, joined — the human message(s). */
  message: string;
  /**
   * `navigator.onLine` at capture time, or `null` when it could not be read.
   * `null` is NOT treated as offline: the flag is unreliable enough already,
   * and guessing would drop real failures.
   */
  online: boolean | null;
  /** `source` of each stack frame, where the capture carried them. */
  sources?: readonly string[];
}

/** Why an exception was dropped, or `null` to keep it. */
export type DropReason = 'offline' | 'auth-lock-contention' | 'dev-hot-update';

/** A transport failure rather than a fault in our code. */
const CONNECTIVITY =
  /failed to fetch|could not reach backend|networkerror|load failed/i;

/**
 * Supabase's cross-tab auth lock changing hands.
 *
 * `@supabase/auth-js` guards token refresh with a Web Lock and takes it with
 * `steal`, so whichever holder is displaced throws. Both sides of that exchange
 * surface here: the loser reports the lock "was released", the winner's aborted
 * request reports the lock was "broken". It is the library working as designed
 * — a second app window is enough to produce it — and there is no code change
 * on our side that would prevent it.
 */
const AUTH_LOCK =
  /Lock ["']?lock:sb-.*was released because another request stole it|Lock broken by another request with the ['"]steal['"] option/i;

/**
 * A frame from a dev server's hot-module-replacement bundle.
 *
 * Autocapture is already meant to be off outside packaged builds, gated on
 * `NODE_ENV`. That gate misses a dev server started with `NODE_ENV=production`,
 * which is how React hook-order errors and "… is not a function" from a
 * half-applied hot update reached the project. A `hot-update` frame cannot
 * occur in a packaged build, so it is a reliable second gate.
 */
const HOT_UPDATE = /hot-update\.js/i;

/**
 * Why this exception should be dropped, or `null` to keep it.
 *
 * Returns the reason rather than a boolean so the rules stay individually
 * testable, and so a caller that wants to count what it discards can.
 */
export function exceptionDropReason(
  exception: CapturedException
): DropReason | null {
  const { message, online, sources } = exception;

  if (sources?.some((source) => HOT_UPDATE.test(source))) {
    return 'dev-hot-update';
  }

  if (AUTH_LOCK.test(message)) {
    return 'auth-lock-contention';
  }

  // Offline ONLY. A request that fails with no network is the expected result,
  // not a defect, and the app already tells the user through its offline
  // banner. The online case is deliberately kept: `online: true` with a
  // transport failure means the backend itself was unreachable, which is the
  // one connectivity signal that can reflect a real outage.
  if (online === false && CONNECTIVITY.test(message)) {
    return 'offline';
  }

  return null;
}

/** Whether this exception is worth capturing at all. */
export function shouldCaptureException(exception: CapturedException): boolean {
  return exceptionDropReason(exception) === null;
}

/** Whether a message looks like a transport failure rather than a code fault. */
export function isConnectivityMessage(message: string): boolean {
  return CONNECTIVITY.test(message);
}
