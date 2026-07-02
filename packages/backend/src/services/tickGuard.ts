/**
 * Re-entry guard for interval-driven poll loops, with a wedge watchdog.
 *
 * Every poller uses the same shape — `if (busy) return; busy = true; try {…}
 * finally { busy = false }` — which has a fatal failure mode: the `finally`
 * only runs when the tick's awaits settle. One await that never resolves (a
 * stalled socket, a hung DB call) leaves the flag held forever and silently
 * freezes the loop — no ticks, no errors. This wedged the merge queue twice
 * in prod (June 2026): first mid-drain with 15 mergeable PRs stuck, then
 * again when a merge response's body stalled — and the PR monitor, which had
 * no watchdog at all, wedged alongside it, so nothing ever reconciled the
 * merged PR and the queue appeared frozen in the UI.
 *
 * `tryBegin()` refuses re-entry while a tick runs, but force-releases the
 * lock once it has been held past `maxTickMs` — so a wedged tick costs at
 * most one watchdog window, never the whole loop.
 */
const DEFAULT_MAX_TICK_MS = 5 * 60_000;

export class TickGuard {
  private running = false;
  private startedAt = 0;

  constructor(
    private readonly name: string,
    private readonly maxTickMs: number = DEFAULT_MAX_TICK_MS
  ) {}

  /** True while a tick holds the guard (e.g. for drain/wait loops). */
  get active(): boolean {
    return this.running;
  }

  /** How long the current holder has been running (0 when idle) — for skip reporting. */
  get heldMs(): number {
    return this.running ? Date.now() - this.startedAt : 0;
  }

  /**
   * Claim the guard for a new tick. Returns false while a previous tick is
   * still legitimately running; force-releases (with a loud log) when the
   * holder has been wedged past `maxTickMs`.
   */
  tryBegin(): boolean {
    if (this.running) {
      const heldMs = Date.now() - this.startedAt;
      if (heldMs <= this.maxTickMs) return false;
      console.error(
        `[${this.name}] previous tick wedged for ${heldMs}ms — force-releasing the lock`
      );
    }
    this.running = true;
    this.startedAt = Date.now();
    return true;
  }

  /** Release the guard — call from the tick's `finally`. */
  end(): void {
    this.running = false;
  }
}
