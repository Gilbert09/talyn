/**
 * Run at most `max` of the given tasks at once; the rest wait in FIFO order.
 *
 * For background work that each holds a pooled DB connection while it runs. An
 * unbounded burst of it can take the whole pool, and then the requests, the
 * webhook worker and the DB watchdog's probe all wait behind it.
 */
export function createConcurrencyLimit(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const start = queue.shift();
    if (start) start();
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
