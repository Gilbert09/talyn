import { runWithoutScope } from '../../../db/client.js';
import { guardCrossReplica } from '../../advisoryLock.js';
import { debugBus } from '../../debugBus.js';
import { TickGuard } from '../../tickGuard.js';
import { chargeOwnerAt } from './charge.js';
import { expireCreditLots } from './credits.js';
import { ownersWithUnbilledQuery } from './intervals.js';
import { UsageSweep, type TenantClient } from './sweep.js';

export const USAGE_METER_POLLER = 'usage-meter';

/**
 * One minute: the longest a running box goes unbilled, and so the most a
 * sweep-detected suspend can lag. Each tick reads the open intervals (a
 * partial index) and lists each fleet host once.
 */
const INTERVAL_MS = 60_000;

/** Expired lots are zeroed once a day; the budget ignores them before that. */
const EXPIRE_EVERY_MS = 24 * 60 * 60_000;

export interface MeterTickResult {
  owners: number;
  opened: number;
  closed: number;
  failedOwners: number;
}

export class UsageMeter {
  private timer: NodeJS.Timeout | null = null;
  private readonly guard = new TickGuard(USAGE_METER_POLLER, 5 * 60_000);
  private readonly sweep: UsageSweep;
  private lastExpireAt = 0;

  constructor(clients?: () => Promise<TenantClient[]>) {
    this.sweep = new UsageSweep(clients);
  }

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      USAGE_METER_POLLER,
      INTERVAL_MS,
      'Bills running fleet boxes against included box-hours and credits. Reconciles open intervals with the fleet (idle suspends, missed hooks), then charges every owner with a box running.',
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<MeterTickResult | null> {
    if (!this.guard.tryBegin()) return null;
    const startedAt = Date.now();
    try {
      // One replica per tick. A lost race costs one extra pass, which the
      // charge step's CAS makes harmless.
      const outcome = await guardCrossReplica(`${USAGE_METER_POLLER}:tick`, () => this.run(now), { maxHoldMs: this.guard.maxMs });
      debugBus.pollerTick(USAGE_METER_POLLER, { durationMs: Date.now() - startedAt, ok: true });
      return outcome.acquired ? (outcome.result ?? null) : null;
    } catch (error) {
      debugBus.pollerTick(USAGE_METER_POLLER, { durationMs: Date.now() - startedAt, ok: false, error });
      return null;
    } finally {
      this.guard.end();
    }
  }

  /** Sweep first, so a box the fleet suspended closes at its suspend time before it is charged. */
  async run(now = new Date()): Promise<MeterTickResult> {
    let opened = 0;
    let closed = 0;
    try {
      ({ opened, closed } = await this.sweep.run(now));
    } catch (error) {
      // Charging what the hooks recorded is still right without the sweep.
      debugBus.recordEvent({ service: 'billing', action: 'usage_sweep_failed', summary: 'Usage sweep failed', ok: false, error });
    }
    const owners = await ownersWithUnbilledQuery();
    let failedOwners = 0;
    for (const { ownerId } of owners) {
      try {
        await chargeOwnerAt(ownerId, now);
      } catch (error) {
        failedOwners += 1;
        debugBus.recordEvent({ service: 'billing', action: 'usage_charge_failed', summary: `Charge failed for owner ${ownerId}`, ok: false, error });
      }
    }
    if (now.getTime() - this.lastExpireAt >= EXPIRE_EVERY_MS) {
      this.lastExpireAt = now.getTime();
      await expireCreditLots(now).catch((error) =>
        debugBus.recordEvent({ service: 'billing', action: 'credit_expire_failed', summary: 'Credit expiry failed', ok: false, error }),
      );
    }
    return { owners: owners.length, opened, closed, failedOwners };
  }
}

export const usageMeter = new UsageMeter();

export function initUsageMeter(): void {
  runWithoutScope(() => usageMeter.init());
}
