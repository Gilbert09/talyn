import type { Micros } from '@talyn/shared';

/**
 * STUB from WP2 (usage ledger). WP6 replaces this BODY with the real
 * off-session Polar charge; keep the signature.
 *
 * The usage meter calls this when an owner's overage is not covered by their
 * credits (`shortfallMicros` > 0), or when credits were burned and the balance
 * fell below the owner's trigger (`shortfallMicros` may be 0). Return true only
 * when a lot was GRANTED before returning (call `grantCreditLot` from
 * `usage/credits.ts` with the order id, which is idempotent with the later
 * `order.paid`): the meter then burns the shortfall from it at once. Return
 * false on any refusal or failure; the meter then treats the owner as out of
 * budget. Must not throw.
 */
export async function tryAutoTopUp(_ownerId: string, _shortfallMicros: Micros): Promise<boolean> {
  return false;
}
