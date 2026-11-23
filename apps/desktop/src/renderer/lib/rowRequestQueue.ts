/**
 * Runs per-row settings requests a few at a time.
 *
 * Each signed-in request holds one backend DB connection for its whole life,
 * and some of these routes need a second one. The backend pool has 20, so a
 * page that fires three requests for every repository at once can take them
 * all and deadlock the backend (2026-11-12). Four at a time keeps a page well
 * under the pool and leaves room for everything else.
 */
const MAX_IN_FLIGHT = 4;

let inFlight = 0;
const waiting: Array<() => void> = [];

export async function queuedRowRequest<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}
