import { runWithoutScope } from '../../db/client.js';
import { debugBus } from '../debugBus.js';
import { backfillMergeArchives, MERGE_BACKFILL_POLLER } from './mergeBackfill.js';
import { reapWorkbenchSandboxes, REAPER_POLLER } from './reaper.js';

const timers: NodeJS.Timeout[] = [];
export function initWorkbenchMaintenance(): void {
  if (timers.length) return;
  for (const [name, interval, description, run] of [
    [MERGE_BACKFILL_POLLER, 10 * 60_000, 'Removes stale PR links and archives sessions after a merge.', backfillMergeArchives],
    [REAPER_POLLER, 5 * 60_000, 'Deletes unused session sandboxes after the grace period.', reapWorkbenchSandboxes],
  ] as const) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      const started = Date.now();
      let error: unknown;
      try { await runWithoutScope(() => run()); } catch (err) { error = err; }
      finally {
        running = false;
        debugBus.pollerTick(name, { durationMs: Date.now() - started, ok: !error, error });
      }
    };
    debugBus.registerPoller(name, interval, description);
    const timer = setInterval(() => void tick(), interval);
    timer.unref();
    timers.push(timer);
    void tick();
  }
}

export function stopWorkbenchMaintenance(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
}
